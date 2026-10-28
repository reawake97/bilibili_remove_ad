import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GRPC_SCRIPT = path.join(ROOT, 'scripts/bilibili.grpc.js');
export const JSON_SCRIPT = path.join(ROOT, 'scripts/bilibili.json.js');

/**
 * 在一个只有 ECMAScript 内置对象的 vm 上下文里运行脚本，模拟 Quantumult X：
 * 没有 TextDecoder / URL / Buffer，$request / $response 的 ArrayBuffer 在脚本所在的 realm 中创建。
 */
export function runScript(file, { url, method = 'POST', headers = {}, body, response, fetch, timeout = 10000, transform = code => code }) {
    const code = transform(fs.readFileSync(file, 'utf8'));
    return new Promise((resolve, reject) => {
        const logs = [];
        const fetchCalls = [];
        let doneCount = 0;
        const timer = setTimeout(() => reject(new Error('$done 未被调用')), timeout);
        const context = vm.createContext({
            console: { log: (...args) => logs.push(args.join(' ')) },
            setTimeout,
            clearTimeout,
            $notify() {},
            $prefs: { valueForKey: () => null, setValueForKey: () => true },
            $task: {
                fetch(request) {
                    fetchCalls.push(request);
                    return fetch ? fetch(request, fetchCalls.length - 1) : Promise.reject({ error: 'offline' });
                },
            },
            $done(result) {
                doneCount++;
                clearTimeout(timer);
                // 稍等一下，确认 $done 只被调用一次
                setTimeout(() => resolve({ result, logs, fetchCalls, doneCount }), 20);
            },
        });
        context.__init = { url, method, headers, body, response };
        vm.runInContext(
            `(init => {
                const toBuffer = bytes => {
                    if (!bytes) return undefined;
                    const buffer = new ArrayBuffer(bytes.length);
                    new Uint8Array(buffer).set(bytes);
                    return buffer;
                };
                globalThis.$request = { url: init.url, method: init.method, headers: init.headers, bodyBytes: toBuffer(init.body) };
                if (init.response) {
                    globalThis.$response = {
                        statusCode: init.response.status || 200,
                        headers: init.response.headers || {},
                        bodyBytes: toBuffer(init.response.bodyBytes),
                        body: init.response.body,
                    };
                }
            })(__init);
            delete globalThis.__init;`,
            context
        );
        try {
            vm.runInContext(code, context, { filename: path.basename(file), timeout: 5000 });
        } catch (e) {
            clearTimeout(timer);
            reject(e);
        }
    });
}

export const bytesOf = buffer => new Uint8Array(buffer);

/* ---------------- 独立于被测脚本的 protobuf 编解码（只用于构造与检查测试数据） ---------------- */

function varint(value) {
    const out = [];
    let v = BigInt(value);
    if (v < 0n) v += 1n << 64n;
    while (v > 0x7fn) {
        out.push(Number(v & 0x7fn) | 0x80);
        v >>= 7n;
    }
    out.push(Number(v));
    return out;
}

export function concat(...parts) {
    const flat = parts.flat(Infinity).map(p => (p instanceof Uint8Array ? Array.from(p) : p));
    return Uint8Array.from(flat.flat());
}

export const pb = {
    int: (no, value) => concat(varint(no * 8), varint(value)),
    bytes: (no, data) => {
        const bytes = data instanceof Uint8Array ? data : concat(data);
        return concat(varint(no * 8 + 2), varint(bytes.length), bytes);
    },
    str: (no, text) => pb.bytes(no, new TextEncoder().encode(text)),
    msg: (no, ...fields) => pb.bytes(no, concat(...fields)),
    fixed32: (no, value) => concat(varint(no * 8 + 5), [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]),
    fixed64: (no, lo) => concat(varint(no * 8 + 1), [lo & 0xff, (lo >> 8) & 0xff, (lo >> 16) & 0xff, (lo >>> 24) & 0xff, 0, 0, 0, 0]),
};

export function decode(bytes) {
    const fields = [];
    let pos = 0;
    const read = () => {
        let result = 0n;
        let shift = 0n;
        for (;;) {
            const b = bytes[pos++];
            result |= BigInt(b & 0x7f) << shift;
            if (!(b & 0x80)) return result;
            shift += 7n;
        }
    };
    while (pos < bytes.length) {
        const start = pos;
        const tag = Number(read());
        const no = tag >>> 3;
        const wt = tag & 7;
        let value;
        if (wt === 0) value = Number(read());
        else if (wt === 1) (value = bytes.subarray(pos, pos + 8)), (pos += 8);
        else if (wt === 5) (value = bytes.subarray(pos, pos + 4)), (pos += 4);
        else if (wt === 2) {
            const length = Number(read());
            value = bytes.subarray(pos, pos + length);
            pos += length;
        } else throw new Error(`wire type ${wt}`);
        fields.push({ no, wt, value, raw: bytes.subarray(start, pos) });
    }
    return fields;
}

export const fieldsOf = (bytes, no) => decode(bytes).filter(f => f.no === no);
export const text = bytes => new TextDecoder().decode(bytes);

export function grpcFrame(message, compressedPayload) {
    const payload = compressedPayload || message;
    const header = [compressedPayload ? 1 : 0, (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 8) & 0xff, payload.length & 0xff];
    return concat(header, payload);
}

export function unframe(body) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    const length = ((bytes[1] << 24) >>> 0) + (bytes[2] << 16) + (bytes[3] << 8) + bytes[4];
    return { flag: bytes[0], message: bytes.subarray(5, 5 + length), rest: bytes.subarray(5 + length) };
}

// $done({}) 表示不做任何修改（对象来自 vm 上下文，不能和宿主的 {} 做严格深比较）
export function assertPassThrough(result) {
    if (!result || typeof result !== 'object' || Object.keys(result).length !== 0) {
        throw new Error(`应放行（$done({})），实际为 ${JSON.stringify(result)}`);
    }
}
