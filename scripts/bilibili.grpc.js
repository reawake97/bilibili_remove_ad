/**
 * 哔哩哔哩去广告 · gRPC 处理脚本（Quantumult X 专用）
 *
 * 仓库：https://github.com/reawake97/bilibili_remove_ad
 * 许可：GPL-3.0-or-later
 *
 * 去广告逻辑移植自 kokoryh/Sparkle（GPL-3.0）的 bilibili.protobuf.request / response 脚本，
 * 也就是 Loon 插件「哔哩哔哩去广告」(kelee.one) 所用的脚本。原脚本在 Quantumult X 下会直接
 * 抛出 "QuantumultX is not supported"，所以这里重新实现了一个不依赖任何第三方库的版本：
 * 直接在 protobuf 线格式上删除 / 过滤字段，没有改动的字段按原字节保留，不需要完整的 proto 定义。
 *
 * 在 Bilibili_remove_ads.conf 中有三种用法：
 *   script-response-body   过滤 gRPC 响应里的广告，并按需补上 grpc-status 响应头（修复评论区加载失败）
 *   script-request-header  直接返回空的 gRPC 响应（青少年模式弹窗、搜索默认词、暂停 / 结束页广告）
 *   script-request-body    「优化评论区加载」（可选）：由脚本自行请求 View/View 与 Reply/MainList
 */

const SETTINGS = {
    // 动态页「最常访问」：show 始终显示 | hide 始终隐藏 | auto 仅当列表中有直播时显示
    displayUpList: 'show',
    // 移除评论区置顶的带货 / 推广评论
    purifyComment: true,
    // 日志等级：debug | info | warn | error | off
    logLevel: 'error',
};

// 「优化评论区加载」：单次请求超时（毫秒）与重试顺序，与 Loon 插件一致
const FETCH_TIMEOUT = 3000;
const FETCH_HOSTS = ['grpc.biliapi.net', 'app.bilibili.com'];
// 标记脚本自己发出的请求，避免被本脚本的请求重写再次拦截而循环
const FETCH_MARK = 'x-bili-remove-ads';

/* ------------------------------------------------------------------ */
/* 日志与通用工具                                                       */
/* ------------------------------------------------------------------ */

const LOG_LEVELS = { debug: 1, info: 2, warn: 3, error: 4, off: 5 };

function log(level, ...messages) {
    if (LOG_LEVELS[level] < (LOG_LEVELS[SETTINGS.logLevel] || LOG_LEVELS.error)) return;
    console.log(`[哔哩哔哩去广告][${level}] ${messages.map(stringify).join(' ')}`);
}

function stringify(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'object' && value !== null) {
        try {
            return JSON.stringify(value);
        } catch (e) {
            // 循环引用等，退回 String()
        }
    }
    return String(value);
}

let finished = false;

function done(result) {
    if (finished) return;
    finished = true;
    $done(result || {});
}

function parseUrl(url) {
    const match = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(url || '') || [];
    return {
        host: (match[2] || '').toLowerCase().replace(/:\d+$/, ''),
        path: match[3] || '/',
        query: match[4] || '',
    };
}

function findHeaderKey(headers, name) {
    if (!headers) return undefined;
    const lower = name.toLowerCase();
    return Object.keys(headers).find(key => key.toLowerCase() === lower);
}

function getHeader(headers, name) {
    const key = findHeaderKey(headers, name);
    return key === undefined ? undefined : headers[key];
}

function omitHeaders(headers, shouldOmit) {
    const result = {};
    for (const key of Object.keys(headers || {})) {
        if (!shouldOmit(key.toLowerCase())) result[key] = headers[key];
    }
    return result;
}

// 不用 instanceof：Quantumult X 传入的 ArrayBuffer 未必来自脚本所在的 realm
function toUint8Array(data) {
    if (data === undefined || data === null) return null;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data);
    return null;
}

function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function utf8Decode(bytes) {
    let result = '';
    let chunk = [];
    let i = 0;
    while (i < bytes.length) {
        const c = bytes[i++];
        if (c < 0x80) {
            chunk.push(c);
        } else if (c >= 0xc0 && c < 0xe0 && i < bytes.length) {
            chunk.push(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
        } else if (c >= 0xe0 && c < 0xf0 && i + 1 < bytes.length) {
            chunk.push(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
        } else if (c >= 0xf0 && c < 0xf8 && i + 2 < bytes.length) {
            const point =
                (((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)) -
                0x10000;
            chunk.push(0xd800 + (point >> 10), 0xdc00 + (point & 0x3ff));
        } else {
            chunk.push(0xfffd);
        }
        if (chunk.length >= 4096) {
            result += String.fromCharCode.apply(null, chunk);
            chunk = [];
        }
    }
    return result + String.fromCharCode.apply(null, chunk);
}

/* ------------------------------------------------------------------ */
/* protobuf 线格式                                                      */
/* ------------------------------------------------------------------ */

function readVarint(bytes, pos) {
    let value = 0;
    let factor = 1;
    for (let i = 0; i < 10; i++) {
        if (pos >= bytes.length) throw new Error('varint 越界');
        const b = bytes[pos++];
        // 超过 2^53 的值会丢精度，这里只用于字段号、长度和枚举比较，不影响结果
        value += (b & 0x7f) * factor;
        if (!(b & 0x80)) return [value, pos];
        factor *= 128;
    }
    throw new Error('varint 过长');
}

function encodeVarint(value) {
    const out = [];
    while (value > 0x7f) {
        out.push((value % 128) | 0x80);
        value = Math.floor(value / 128);
    }
    out.push(value);
    return out;
}

function encodeField(field) {
    const tag = encodeVarint(field.no * 8 + field.wt);
    if (field.wt === 0) return Uint8Array.from(tag.concat(encodeVarint(field.value)));
    const length = encodeVarint(field.value.length);
    const out = new Uint8Array(tag.length + length.length + field.value.length);
    out.set(tag, 0);
    out.set(length, tag.length);
    out.set(field.value, tag.length + length.length);
    return out;
}

/**
 * 一条 protobuf 消息的字段列表。
 * 每个字段保存原始字节（raw），没有改动的字段序列化时原样输出，未知字段因此全部保留。
 */
class Message {
    constructor(bytes) {
        this.bytes = bytes;
        this.fields = [];
        this.changed = false;
        let pos = 0;
        while (pos < bytes.length) {
            const start = pos;
            let tag;
            [tag, pos] = readVarint(bytes, pos);
            const no = Math.floor(tag / 8);
            const wt = tag % 8;
            if (no === 0) throw new Error('字段号为 0');
            let value = null;
            if (wt === 0) {
                [value, pos] = readVarint(bytes, pos);
            } else if (wt === 1) {
                pos += 8;
            } else if (wt === 2) {
                let length;
                [length, pos] = readVarint(bytes, pos);
                if (pos + length > bytes.length) throw new Error('length-delimited 字段越界');
                value = bytes.subarray(pos, pos + length);
                pos += length;
            } else if (wt === 5) {
                pos += 4;
            } else {
                throw new Error(`不支持的 wire type ${wt}`);
            }
            if (pos > bytes.length) throw new Error('字段越界');
            this.fields.push({ no, wt, value, raw: bytes.subarray(start, pos) });
        }
    }

    static tryParse(bytes) {
        if (!bytes) return null;
        try {
            return new Message(bytes);
        } catch (e) {
            log('debug', '子消息解析失败，保持原样', e);
            return null;
        }
    }

    all(no) {
        return this.fields.filter(field => field.no === no);
    }

    last(no) {
        for (let i = this.fields.length - 1; i >= 0; i--) {
            if (this.fields[i].no === no) return this.fields[i];
        }
        return undefined;
    }

    has(no) {
        return this.fields.some(field => field.no === no);
    }

    varint(no) {
        const field = this.last(no);
        return field && field.wt === 0 ? field.value : 0;
    }

    bytesOf(no) {
        const field = this.last(no);
        return field && field.wt === 2 ? field.value : undefined;
    }

    string(no) {
        const value = this.bytesOf(no);
        return value ? utf8Decode(value) : '';
    }

    remove(...nos) {
        const count = this.fields.length;
        this.fields = this.fields.filter(field => !nos.includes(field.no));
        if (this.fields.length !== count) this.changed = true;
        return this;
    }

    // 过滤 repeated 的 length-delimited 字段；keep 返回 false 的条目被删除
    filter(no, keep) {
        this.fields = this.fields.filter(field => {
            if (field.no !== no || field.wt !== 2) return true;
            if (keep(field.value)) return true;
            this.changed = true;
            return false;
        });
        return this;
    }

    // 把字段当作子消息修改；解析失败的条目保持原样
    edit(no, fn) {
        for (const field of this.fields) {
            if (field.no !== no || field.wt !== 2) continue;
            const sub = Message.tryParse(field.value);
            if (!sub) continue;
            fn(sub);
            if (sub.changed) this.replaceValue(field, sub.toBytes());
        }
        return this;
    }

    replaceValue(field, value) {
        field.value = value;
        field.raw = null;
        this.changed = true;
    }

    // 用 newFields 替换所有字段号为 no 的字段，位置取原来第一次出现的地方
    replaceAll(no, newFields) {
        const index = this.fields.findIndex(field => field.no === no);
        this.fields = this.fields.filter(field => field.no !== no);
        this.fields.splice(index === -1 ? this.fields.length : index, 0, ...newFields);
        this.changed = true;
        return this;
    }

    setVarint(no, value) {
        return this.replaceAll(no, [{ no, wt: 0, value, raw: null }]);
    }

    toBytes() {
        if (!this.changed) return this.bytes;
        const chunks = this.fields.map(field => field.raw || encodeField(field));
        const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }
}

/* ------------------------------------------------------------------ */
/* gzip / zlib / deflate 解压（RFC 1950-1952）                          */
/* Quantumult X 没有 $utils.ungzip，B 站较大的 gRPC 响应会以 gzip 压缩   */
/* ------------------------------------------------------------------ */

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths, count) {
    const counts = new Uint16Array(16);
    const offsets = new Uint16Array(16);
    const symbols = new Uint16Array(count);
    for (let i = 0; i < count; i++) counts[lengths[i]]++;
    counts[0] = 0;
    for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
    for (let i = 0; i < count; i++) {
        if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
    }
    return { counts, symbols };
}

let fixedTables = null;

function getFixedTables() {
    if (!fixedTables) {
        const lengths = new Uint8Array(288);
        lengths.fill(8, 0, 144);
        lengths.fill(9, 144, 256);
        lengths.fill(7, 256, 280);
        lengths.fill(8, 280, 288);
        fixedTables = { lit: buildHuffman(lengths, 288), dist: buildHuffman(new Uint8Array(30).fill(5), 30) };
    }
    return fixedTables;
}

function inflateRaw(data, sizeHint) {
    let pos = 0;
    let bitBuf = 0;
    let bitCnt = 0;
    let out = new Uint8Array(sizeHint > 0 && sizeHint < 64 * 1024 * 1024 ? sizeHint : Math.max(1024, data.length * 4));
    let outPos = 0;

    const ensure = size => {
        if (outPos + size <= out.length) return;
        let capacity = out.length * 2;
        while (capacity < outPos + size) capacity *= 2;
        const grown = new Uint8Array(capacity);
        grown.set(out.subarray(0, outPos));
        out = grown;
    };

    const bits = n => {
        while (bitCnt < n) {
            if (pos >= data.length) throw new Error('deflate 数据不完整');
            bitBuf |= data[pos++] << bitCnt;
            bitCnt += 8;
        }
        const value = bitBuf & ((1 << n) - 1);
        bitBuf >>>= n;
        bitCnt -= n;
        return value;
    };

    const decodeSymbol = table => {
        let code = 0;
        let first = 0;
        let index = 0;
        for (let length = 1; length < 16; length++) {
            code |= bits(1);
            const count = table.counts[length];
            if (code - count < first) return table.symbols[index + (code - first)];
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        throw new Error('deflate Huffman 编码无效');
    };

    const inflateBlock = (lit, dist) => {
        for (;;) {
            let symbol = decodeSymbol(lit);
            if (symbol < 256) {
                ensure(1);
                out[outPos++] = symbol;
            } else if (symbol === 256) {
                return;
            } else {
                symbol -= 257;
                if (symbol >= 29) throw new Error('deflate 长度码无效');
                const length = LENGTH_BASE[symbol] + bits(LENGTH_EXTRA[symbol]);
                const distSymbol = decodeSymbol(dist);
                if (distSymbol >= 30) throw new Error('deflate 距离码无效');
                const distance = DIST_BASE[distSymbol] + bits(DIST_EXTRA[distSymbol]);
                if (distance > outPos) throw new Error('deflate 距离超出范围');
                ensure(length);
                for (let i = 0; i < length; i++) {
                    out[outPos] = out[outPos - distance];
                    outPos++;
                }
            }
        }
    };

    const readDynamicTables = () => {
        const litCount = bits(5) + 257;
        const distCount = bits(5) + 1;
        const codeCount = bits(4) + 4;
        if (litCount > 286 || distCount > 30) throw new Error('deflate 码表大小无效');
        const codeLengths = new Uint8Array(19);
        for (let i = 0; i < codeCount; i++) codeLengths[CODE_LENGTH_ORDER[i]] = bits(3);
        const codeTable = buildHuffman(codeLengths, 19);
        const lengths = new Uint8Array(litCount + distCount);
        let index = 0;
        while (index < lengths.length) {
            const symbol = decodeSymbol(codeTable);
            if (symbol < 16) {
                lengths[index++] = symbol;
                continue;
            }
            let value = 0;
            let repeat;
            if (symbol === 16) {
                if (index === 0) throw new Error('deflate 重复码无前值');
                value = lengths[index - 1];
                repeat = 3 + bits(2);
            } else if (symbol === 17) {
                repeat = 3 + bits(3);
            } else {
                repeat = 11 + bits(7);
            }
            if (index + repeat > lengths.length) throw new Error('deflate 码长越界');
            lengths.fill(value, index, index + repeat);
            index += repeat;
        }
        if (!lengths[256]) throw new Error('deflate 缺少块结束符');
        return {
            lit: buildHuffman(lengths.subarray(0, litCount), litCount),
            dist: buildHuffman(lengths.subarray(litCount), distCount),
        };
    };

    let last = 0;
    while (!last) {
        last = bits(1);
        const type = bits(2);
        if (type === 0) {
            bitBuf = 0;
            bitCnt = 0;
            if (pos + 4 > data.length) throw new Error('deflate stored 块不完整');
            const length = data[pos] | (data[pos + 1] << 8);
            const check = data[pos + 2] | (data[pos + 3] << 8);
            pos += 4;
            if (length !== (~check & 0xffff)) throw new Error('deflate stored 块长度校验失败');
            if (pos + length > data.length) throw new Error('deflate stored 块不完整');
            ensure(length);
            out.set(data.subarray(pos, pos + length), outPos);
            outPos += length;
            pos += length;
        } else if (type === 1) {
            const tables = getFixedTables();
            inflateBlock(tables.lit, tables.dist);
        } else if (type === 2) {
            const tables = readDynamicTables();
            inflateBlock(tables.lit, tables.dist);
        } else {
            throw new Error('deflate 块类型无效');
        }
    }
    return out.subarray(0, outPos);
}

function gunzip(data) {
    if (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8) throw new Error('不是 gzip 数据');
    const flags = data[3];
    let pos = 10;
    if (flags & 4) pos += 2 + (data[pos] | (data[pos + 1] << 8));
    if (flags & 8) while (pos < data.length && data[pos++] !== 0);
    if (flags & 16) while (pos < data.length && data[pos++] !== 0);
    if (flags & 2) pos += 2;
    if (pos > data.length - 8) throw new Error('gzip 头部无效');
    const end = data.length;
    const size = (data[end - 4] | (data[end - 3] << 8) | (data[end - 2] << 16) | (data[end - 1] << 24)) >>> 0;
    return inflateRaw(data.subarray(pos, end - 8), size);
}

function decompress(data) {
    if (data[0] === 0x1f && data[1] === 0x8b) return gunzip(data);
    if (data.length > 2 && (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0 && !(data[1] & 0x20)) {
        return inflateRaw(data.subarray(2, data.length - 4));
    }
    return inflateRaw(data);
}

/* ------------------------------------------------------------------ */
/* gRPC 帧                                                              */
/* ------------------------------------------------------------------ */

// 只处理一元调用：一个数据帧，后面可以跟 gRPC-Web 的 trailer 帧（原样保留）
function decodeGrpc(body) {
    if (body.length < 5) throw new Error('gRPC 响应过短');
    const flag = body[0];
    if (flag & 0x80) throw new Error('只有 trailer 帧，没有消息');
    const length = body[1] * 0x1000000 + (body[2] << 16) + (body[3] << 8) + body[4];
    if (5 + length > body.length) throw new Error('gRPC 帧长度与响应体不符');
    const rest = body.subarray(5 + length);
    if (rest.length && !(rest[0] & 0x80)) throw new Error('包含多个数据帧（流式响应），不处理');
    const payload = body.subarray(5, 5 + length);
    return { message: flag & 1 ? decompress(payload) : payload, rest };
}

// 重新编码为不压缩的帧（压缩标志位为 0 时客户端不会再按 grpc-encoding 解压）
function encodeGrpc(message, rest) {
    const restLength = rest ? rest.length : 0;
    const out = new Uint8Array(5 + message.length + restLength);
    const length = message.length;
    out[1] = (length >>> 24) & 0xff;
    out[2] = (length >>> 16) & 0xff;
    out[3] = (length >>> 8) & 0xff;
    out[4] = length & 0xff;
    out.set(message, 5);
    if (restLength) out.set(rest, 5 + length);
    return out;
}

/**
 * 评论区加载失败的根源：代理改写 gRPC 响应后，HTTP/2 trailers 里的 grpc-status 丢失，
 * 新版客户端（x-bili-moss-engine-type: 1）就把整个响应判为失败。
 * 规则综合 kokoryh/Sparkle 与 Biliverse/ADBlock（2026-01 起两者均加入了同样的修复）：
 *   - 白 B（bili-inter）不能带 grpc-status: 0
 *   - 蓝 B（bili-blue）必须带
 *   - 其他版本：请求头 te: trailers 或 x-bili-moss-engine-type: 1 时补上
 * force 用于脚本自己构造的响应：这类响应一定没有 trailers。
 */
function fixGrpcStatus(requestHeaders, responseHeaders, force) {
    const headers = Object.assign({}, responseHeaders);
    const ua = String(getHeader(requestHeaders, 'user-agent') || '');
    const statusKey = findHeaderKey(headers, 'grpc-status');
    if (ua.includes('bili-inter/')) {
        if (statusKey !== undefined && String(headers[statusKey]) === '0') delete headers[statusKey];
        return headers;
    }
    if (statusKey !== undefined) return headers;
    const te = String(getHeader(requestHeaders, 'te') || '').toLowerCase();
    const engine = String(getHeader(requestHeaders, 'x-bili-moss-engine-type') || '');
    if (force || ua.includes('bili-blue/') || engine === '1' || te.includes('trailers')) headers['grpc-status'] = '0';
    return headers;
}

/* ------------------------------------------------------------------ */
/* 各接口的去广告规则（字段号来自 kokoryh/Sparkle 的 proto 定义）        */
/* ------------------------------------------------------------------ */

// bilibili.app.viewunite.v1.RelateCard.relate_card_type：GAME, CM_TYPE, LIVE, AI_RECOMMEND, COURSE
const EXCLUDED_RELATE_CARD_TYPES = [4, 5, 6, 7, 11];
// bilibili.app.viewunite.v1.ModuleType：ACTIVITY, PAY_BAR, SPECIALTAG, MERCHANDISE, VIDEO_MENTIONS
const EXCLUDED_MODULE_TYPES = [18, 29, 37, 55, 63];
const MODULE_UGC_HEADLINE = 3;
const MODULE_RELATED_RECOMMEND = 28;
// bilibili.app.dynamic.v2.DynamicType：AD, LIVE_RCMD
const EXCLUDED_DYNAMIC_TYPES = [15, 18];
// bilibili.main.community.reply.v1.SubjectTopCard.Type：CM, OPERATION
const EXCLUDED_TOP_CARD_TYPES = [3, 5];
const AD_LINK_PATTERN = /https:\/\/b23\.tv\/(?:cm|mall)/;
const AD_KEYWORD_PATTERN = /淘宝|某宝|天猫|京东|狗东|拼多多|饿了么|美团|转转|妙界|神气小鹿/;
const SEARCH_AD_PATTERN = /_ad_?/;

function keepRelateCard(bytes) {
    const card = Message.tryParse(bytes);
    if (!card) return true;
    if (EXCLUDED_RELATE_CARD_TYPES.includes(card.varint(1))) return false;
    const cmStock = card.bytesOf(11);
    if (cmStock && cmStock.length) return false;
    const basicInfo = Message.tryParse(card.bytesOf(12));
    return !(basicInfo && basicInfo.string(6));
}

// 视频详情页「简介」里的模块：活动、付费条、特殊标签、商品、视频提及；标题标签；相关推荐里的广告卡片
function filterViewModules(container, fieldNo) {
    container.filter(fieldNo, bytes => {
        const module = Message.tryParse(bytes);
        return !module || !EXCLUDED_MODULE_TYPES.includes(module.varint(1));
    });
    container.edit(fieldNo, module => {
        const type = module.varint(1);
        if (type === MODULE_UGC_HEADLINE) {
            module.edit(5, headline => headline.remove(1));
        } else if (type === MODULE_RELATED_RECOMMEND) {
            module.edit(22, relates => relates.filter(1, keepRelateCard));
        }
    });
}

function keepIpadRelate(bytes) {
    const relate = Message.tryParse(bytes);
    const cm = relate && relate.bytesOf(28);
    return !(cm && cm.length);
}

function handleUpList(reply, mode) {
    // kokoryh 原版在 iPad 上总是显示；QX 拿不到设备型号，默认 show 时无影响
    if (mode === 'show') return;
    const field = reply.last(2);
    const upList = field && Message.tryParse(field.value);
    if (!upList) return;
    if (mode === 'hide' || !upList.varint(4)) {
        reply.remove(2);
        return;
    }
    // auto 且有直播：把 list_second 移到 list 前面，并在最后一项上加分隔线
    const second = upList.all(10);
    if (!second.length) return;
    const lastItem = Message.tryParse(second[second.length - 1].value);
    if (!lastItem) return;
    lastItem.setVarint(11, 1);
    const merged = second
        .slice(0, -1)
        .map(item => item.value)
        .concat([lastItem.toBytes()], upList.all(2).map(item => item.value));
    const position = upList.fields.findIndex(item => item.no === 2 || item.no === 10);
    upList.fields = upList.fields.filter(item => item.no !== 2 && item.no !== 10);
    upList.fields.splice(position, 0, ...merged.map(value => ({ no: 2, wt: 2, value, raw: null })));
    upList.changed = true;
    reply.replaceValue(field, upList.toBytes());
}

function keepTopReply(bytes) {
    const reply = Message.tryParse(bytes);
    const content = reply && Message.tryParse(reply.bytesOf(12));
    if (!content) return true;
    const text = content.string(1);
    const links = content.all(5).map(entry => {
        const pair = Message.tryParse(entry.value);
        return pair ? pair.string(1) : '';
    });
    return !links.some(link => AD_LINK_PATTERN.test(link)) && !AD_LINK_PATTERN.test(text) && !AD_KEYWORD_PATTERN.test(text);
}

const RESPONSE_HANDLERS = {
    // 动态综合页：话题、广告卡片、直播推荐、最常访问
    'bilibili.app.dynamic.v2.Dynamic/DynAll'(reply) {
        reply.remove(3);
        reply.edit(1, list =>
            list.filter(1, bytes => {
                const item = Message.tryParse(bytes);
                return !item || !EXCLUDED_DYNAMIC_TYPES.includes(item.varint(1));
            })
        );
        handleUpList(reply, SETTINGS.displayUpList);
    },

    // 热门页
    'bilibili.app.show.v1.Popular/Index'(reply) {
        reply.filter(1, bytes => {
            const card = Message.tryParse(bytes);
            if (!card) return true;
            // oneof item：1 small_cover_v5 | 10 rcmd_one_item | 11 small_cover_v5_ad | 12 topic_list
            let kind = 0;
            for (const field of card.fields) if ([1, 10, 11, 12].includes(field.no)) kind = field.no;
            if (kind !== 1) return kind === 0;
            const cover = Message.tryParse(card.bytesOf(1));
            if (!cover) return true;
            const base = Message.tryParse(cover.bytesOf(1));
            if (!base) return false;
            const adInfo = base.bytesOf(12);
            return base.string(14) === 'recommend' && !(adInfo && adInfo.length);
        });
    },

    // 视频详情页（新版）：广告、充电按钮、简介中的推广模块。评论区的 Tab 也在这个响应里
    'bilibili.app.viewunite.v1.View/View'(reply) {
        reply.remove(7);
        reply.edit(3, reqUser => reqUser.remove(7));
        reply.edit(5, tab => tab.edit(1, tabModule => tabModule.edit(2, intro => filterViewModules(intro, 2))));
    },

    'bilibili.app.viewunite.v1.View/AIRelateAsync'(reply) {
        reply.remove(1);
        reply.edit(2, asyncModule => filterViewModules(asyncModule, 1));
    },

    'bilibili.app.viewunite.v1.View/RelatesFeed'(reply) {
        reply.filter(1, keepRelateCard);
    },

    // 播放进度：去掉进度条上的弹幕互动配置（dm）
    'bilibili.app.viewunite.v1.View/ViewProgress'(reply) {
        reply.remove(4);
    },

    // iPad 旧版视频详情页
    'bilibili.app.view.v1.View/View'(reply) {
        reply.remove(23, 41, 31, 30, 50);
        reply.edit(4, reqUser => reqUser.remove(9));
        reply.filter(10, keepIpadRelate);
    },

    'bilibili.app.view.v1.View/ViewProgress'(reply) {
        reply.remove(1);
    },

    'bilibili.app.view.v1.View/RelatesFeed'(reply) {
        reply.filter(1, keepIpadRelate);
    },

    // 播放器上方的大会员推广提示条
    'bilibili.app.playerunite.v1.Player/PlayViewUnite'(reply) {
        reply.edit(9, viewInfo => viewInfo.remove(2));
    },

    'bilibili.pgc.gateway.player.v2.PlayURL/PlayView'(reply) {
        reply.edit(5, viewInfo => viewInfo.remove(8));
    },

    // 弹幕：问卷、活动弹幕、互动指令弹幕（投票 / 点赞等）
    'bilibili.community.service.dm.v1.DM/DmView'(reply) {
        reply.remove(25, 18);
        reply.edit(22, command => command.remove(1));
    },

    // 评论区：广告位、混排卡片、置顶推广卡片、带货置顶评论
    'bilibili.main.community.reply.v1.Reply/MainList'(reply) {
        reply.remove(11, 27);
        reply.filter(28, bytes => {
            const card = Message.tryParse(bytes);
            return !card || !EXCLUDED_TOP_CARD_TYPES.includes(card.varint(1));
        });
        if (SETTINGS.purifyComment) reply.filter(14, keepTopReply);
    },

    // 搜索结果中的广告
    'bilibili.polymer.app.search.v1.Search/SearchAll'(reply) {
        reply.filter(4, bytes => {
            const item = Message.tryParse(bytes);
            return !item || !SEARCH_AD_PATTERN.test(item.string(4));
        });
    },
};

// 与 Loon 插件相同的空响应（已含 5 字节 gRPC 帧头）
const MOCK_RESPONSES = {
    // 青少年模式弹窗
    'bilibili.app.interface.v1.Teenagers/ModeStatus': [
        0, 0, 0, 0, 19, 10, 17, 8, 2, 18, 9, 116, 101, 101, 110, 97, 103, 101, 114, 115, 32, 2, 42, 0,
    ],
    // 搜索框默认词 → 「搜索视频、番剧或up主」
    'bilibili.app.interface.v1.Search/DefaultWords': [
        0, 0, 0, 0, 33, 26, 29, 230, 144, 156, 231, 180, 162, 232, 167, 134, 233, 162, 145, 227, 128, 129, 231, 149, 170,
        229, 137, 167, 230, 136, 150, 117, 112, 228, 184, 187, 40, 1,
    ],
    'bilibili.app.view.v1.View/TFInfo': [0, 0, 0, 0, 0],
    'bilibili.app.viewunite.v1.View/PlayPause': [0, 0, 0, 0, 0],
    'bilibili.app.viewunite.v1.View/ViewEndPage': [0, 0, 0, 0, 0],
};

const OPTIMIZED_METHODS = ['bilibili.app.viewunite.v1.View/View', 'bilibili.main.community.reply.v1.Reply/MainList'];

/* ------------------------------------------------------------------ */
/* 响应阶段（script-response-body）                                     */
/* ------------------------------------------------------------------ */

// 返回处理后的完整响应体；没有删除任何内容时返回原响应体
function processGrpcBody(method, body) {
    const frame = decodeGrpc(body);
    const reply = new Message(frame.message);
    RESPONSE_HANDLERS[method](reply);
    return reply.changed ? encodeGrpc(reply.toBytes(), frame.rest) : body;
}

function sameHeaders(a, b) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b || {}).length && keys.every(key => b[key] === a[key]);
}

function onResponse(method) {
    if (!RESPONSE_HANDLERS[method]) return done({});
    const body = toUint8Array($response.bodyBytes);
    if (!body || body.length < 5) return done({});
    let output;
    try {
        output = processGrpcBody(method, body);
    } catch (e) {
        log('error', method, e);
        return done({});
    }
    const headers = fixGrpcStatus($request.headers, $response.headers, false);
    if (output === body && sameHeaders(headers, $response.headers)) return done({});
    log('debug', method, `${body.length} -> ${output.length} bytes`);
    // script-response-body 不允许只改响应头，所以总是带上响应体
    done({ headers, bodyBytes: toArrayBuffer(output) });
}

/* ------------------------------------------------------------------ */
/* 请求阶段（script-request-header / script-request-body）               */
/* ------------------------------------------------------------------ */

// Quantumult X 中，请求脚本 $done 一个带 status 的对象即为直接返回响应
function respond(headers, bytes) {
    done({ status: 'HTTP/1.1 200 OK', headers, bodyBytes: toArrayBuffer(bytes) });
}

function fetchWithTimeout(request, timeout) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`请求超时（${timeout}ms）`)), timeout);
        $task.fetch(request).then(
            response => {
                if (typeof clearTimeout === 'function') clearTimeout(timer);
                resolve(response);
            },
            reason => {
                if (typeof clearTimeout === 'function') clearTimeout(timer);
                reject(reason && reason.error ? new Error(reason.error) : reason);
            }
        );
    });
}

function isValidGrpcResponse(response, body) {
    if (!response || response.statusCode !== 200 || !body || body.length < 5) return false;
    const contentType = String(getHeader(response.headers, 'content-type') || '');
    if (!/^application\/grpc/i.test(contentType)) return false;
    const status = getHeader(response.headers, 'grpc-status');
    return status === undefined || String(status) === '0';
}

/**
 * 「优化评论区加载」：对应 Loon 插件的 optimizeRequest。
 * 由脚本重新发起请求（grpc.biliapi.net 失败再换 app.bilibili.com，每次最多 3 秒），
 * 去广告后直接返回带 grpc-status 的完整响应；全部失败则放行原请求，不影响正常加载。
 */
async function optimizeRequest(method) {
    if (getHeader($request.headers, FETCH_MARK) !== undefined) return done({});
    const body = toUint8Array($request.bodyBytes);
    if (!body || body.length < 5) return done({});
    const { host, path } = parseUrl($request.url);
    const start = FETCH_HOSTS.indexOf(host);
    if (start === -1) return done({});

    const requestHeaders = omitHeaders(
        $request.headers,
        key => key.startsWith(':') || ['host', 'content-length', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'accept-encoding'].includes(key)
    );
    requestHeaders[FETCH_MARK] = '1';

    for (let i = start; i < FETCH_HOSTS.length; i++) {
        const url = `https://${FETCH_HOSTS[i]}${path}`;
        try {
            const response = await fetchWithTimeout(
                { url, method: 'POST', headers: requestHeaders, bodyBytes: toArrayBuffer(body) },
                FETCH_TIMEOUT
            );
            const responseBody = toUint8Array(response && response.bodyBytes);
            if (!isValidGrpcResponse(response, responseBody)) {
                log('info', '无效响应', url, response && response.statusCode, response && response.headers);
                continue;
            }
            let output = responseBody;
            try {
                output = processGrpcBody(method, responseBody);
            } catch (e) {
                log('warn', '去广告失败，返回原始响应', method, e);
            }
            const headers = omitHeaders(
                response.headers,
                key => key.startsWith(':') || ['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(key)
            );
            return respond(fixGrpcStatus($request.headers, headers, true), output);
        } catch (e) {
            log('info', '请求失败', url, e);
        }
    }
    log('error', '所有主机均请求失败，放行原请求', method);
    done({});
}

function onRequest(method) {
    const mock = MOCK_RESPONSES[method];
    if (mock) return respond({ 'Content-Type': 'application/grpc', 'grpc-status': '0' }, Uint8Array.from(mock));
    if (OPTIMIZED_METHODS.includes(method)) return optimizeRequest(method);
    done({});
}

/* ------------------------------------------------------------------ */
/* 入口                                                                 */
/* ------------------------------------------------------------------ */

function isResponsePhase() {
    if (typeof $response === 'undefined' || $response === null || typeof $response !== 'object') return false;
    return ['statusCode', 'status', 'bodyBytes', 'body'].some(key => $response[key] !== undefined);
}

(() => {
    try {
        const method = parseUrl($request.url).path.replace(/^\/+/, '');
        const result = isResponsePhase() ? onResponse(method) : onRequest(method);
        if (result && typeof result.then === 'function') {
            result.catch(e => {
                log('error', e);
                done({});
            });
        }
    } catch (e) {
        log('error', e);
        done({});
    }
})();
