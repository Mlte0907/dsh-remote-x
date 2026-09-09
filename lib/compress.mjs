import { Transform } from 'node:stream'
import { brotliCompressSync, gzipSync, brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { COMPRESS_MIN_BYTES, HEAD_BUFFER_BYTES } from './constants.mjs'

const TEXT_TYPES = /^(text\/html|text\/css|application\/javascript|application\/json|text\/event-stream)/i

/**
 * Pick the best compression encoding from Accept-Encoding header.
 * Priority: br > gzip. Returns null if none supported.
 */
export function pickEncoding(acceptEncoding) {
  const ae = String(acceptEncoding ?? '')
  if (/\bbr\b/.test(ae)) return 'br'
  if (/\bgzip\b/.test(ae)) return 'gzip'
  return null
}

/**
 * Decide whether and how to compress a response.
 */
export function shouldCompress(responseHeaders, contentType, acceptEncoding, bodyBytes) {
  const isText = TEXT_TYPES.test(String(contentType ?? ''))
  const alreadyEncoded = responseHeaders['content-encoding'] !== undefined
  if (!isText || bodyBytes < COMPRESS_MIN_BYTES || alreadyEncoded) {
    return { compress: false, encoding: null }
  }
  const encoding = pickEncoding(acceptEncoding)
  return { compress: encoding !== null, encoding }
}

/**
 * Stream transform: compress data with the given encoding.
 * Buffers chunks and compresses in _flush for correctness.
 */
export class CompressTransform extends Transform {
  constructor(encoding) {
    super()
    this._encoding = encoding
    this._chunks = []
  }
  _transform(chunk, _enc, cb) { this._chunks.push(chunk); cb() }
  _flush(cb) {
    const buf = Buffer.concat(this._chunks)
    if (buf.length > 0) {
      const out = this._encoding === 'br' ? brotliCompressSync(buf) : gzipSync(buf)
      this.push(out)
    }
    cb()
  }
}

/**
 * Stream transform: decompress data with the given encoding.
 */
export class DecompressTransform extends Transform {
  constructor(encoding) {
    super()
    this._encoding = encoding
    this._chunks = []
  }
  _transform(chunk, _enc, cb) { this._chunks.push(chunk); cb() }
  _flush(cb) {
    const buf = Buffer.concat(this._chunks)
    if (buf.length > 0) {
      let out
      if (this._encoding === 'br') out = brotliDecompressSync(buf)
      else if (this._encoding === 'gzip') out = gunzipSync(buf)
      else out = inflateSync(buf)
      this.push(out)
    }
    cb()
  }
}

/**
 * Stream transform: inject polyfill script after <head> tag.
 * Detects <head> across chunk boundaries with a small tail buffer.
 * Guarantees single injection.
 */
export class PolyfillInjectTransform extends Transform {
  constructor(polyfill, marker = 'data-dsh-remote-x-polyfill') {
    super()
    this._polyfill = polyfill
    this._marker = marker
    this._injected = false
    this._buffer = ''
    this._buffering = true
  }

  _transform(chunk, _enc, cb) {
    if (this._injected) {
      this.push(chunk)
      cb()
      return
    }
    if (this._buffering) {
      this._buffer += chunk.toString('utf8')
      if (this._buffer.includes(this._marker)) {
        this._injected = true
        this.push(Buffer.from(this._buffer, 'utf8'))
        this._buffer = ''
        this._buffering = false
        cb()
        return
      }
      const headMatch = /<head([^>]*)>/i.exec(this._buffer)
      if (headMatch) {
        const idx = headMatch.index + headMatch[0].length
        const before = this._buffer.slice(0, idx)
        const after = this._buffer.slice(idx)
        this._injected = true
        this._buffering = false
        this._buffer = ''
        this.push(Buffer.from(before + this._polyfill + after, 'utf8'))
        cb()
        return
      }
      if (this._buffer.length > HEAD_BUFFER_BYTES) {
        const keep = this._buffer.slice(-HEAD_BUFFER_BYTES)
        const flush = this._buffer.slice(0, this._buffer.length - HEAD_BUFFER_BYTES)
        this._buffer = keep
        this.push(Buffer.from(flush, 'utf8'))
      }
      cb()
    } else {
      this.push(chunk)
      cb()
    }
  }

  _flush(cb) {
    if (this._buffer) {
      this.push(Buffer.from(this._buffer, 'utf8'))
      this._buffer = ''
    }
    cb()
  }
}