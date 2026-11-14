// Tiny RGBA PNG encoder + progress-bar drawing for the "Looks like the stage" feedback.
const zlib = require('zlib')

const CRC = new Int32Array(256).map((_, n) => {
	let c = n
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
	return c
})
function crc32(buf) {
	let c = -1
	for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8)
	return (c ^ -1) >>> 0
}
function chunk(type, data) {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(td))
	return Buffer.concat([len, td, crc])
}
function encode(w, h, rgba) {
	const raw = Buffer.alloc((w * 4 + 1) * h)
	for (let y = 0; y < h; y++) {
		raw[y * (w * 4 + 1)] = 0
		rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
	}
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(w, 0)
	ihdr.writeUInt32BE(h, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	])
}

// A rounded progress bar (track + fill) on a transparent w×h image, like the stage's.
// colours are [r,g,b,a] with a 0–1.
function progressBar(w, h, frac, fill, track) {
	const rgba = Buffer.alloc(w * h * 4)
	const bw = Math.round(w * 0.74)
	const bh = Math.max(3, Math.round(h * 0.055))
	const x0 = Math.round((w - bw) / 2)
	const y0 = Math.round(h * 0.76)
	const r = bh / 2
	const fillEnd = x0 + bw * Math.max(0, Math.min(1, frac))
	for (let y = y0; y < y0 + bh; y++) {
		for (let x = x0; x < x0 + bw; x++) {
			// pill shape with soft edges
			const cx = Math.min(Math.max(x + 0.5, x0 + r), x0 + bw - r)
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - (y0 + r))
			const cover = Math.max(0, Math.min(1, r - d + 0.5))
			if (!cover) continue
			const c = x + 0.5 < fillEnd ? fill : track
			const i = (y * w + x) * 4
			rgba[i] = c[0]
			rgba[i + 1] = c[1]
			rgba[i + 2] = c[2]
			rgba[i + 3] = Math.round(255 * c[3] * cover)
		}
	}
	return encode(w, h, rgba).toString('base64')
}

module.exports = { encode, progressBar }
