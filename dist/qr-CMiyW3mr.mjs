//#region lib/qr.mjs
/**
* 零依赖 QR 码编码器（字节模式 / 纠错等级 M / 版本 1..40）。
*
* 为什么自己写：插件原本靠 `qrcode` 包的 `lib/core/qrcode.js` 生成二维码，
* 但该依赖在宿主环境里从未安装成功（node_modules 为空），`/qrcode` 接口一调用
* 就抛错，设置页二维码永远出不来。而本机 npm/pnpm 又被内部 peer 依赖
* （@deepseek-ai/*）卡死装不上，所以改为内置一个编码实现，彻底去掉外部依赖。
*
* 实现按 ISO/IEC 18004：字节模式 + 纠错等级 M；版本由内容长度自动选择。
* 与 qrcode 包的 `create(text, { errorCorrectionLevel: 'M' }).modules` 输出
* 同构（{ size, data }，data 为行优先的一维数组，1 = 深色），可直接替换。
*/
/** 各版本的对齐图案中心坐标（下标 0 = 版本 1，版本 1 无对齐图案）。 */
const ALIGN_CENTERS = [
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[
		6,
		22,
		38
	],
	[
		6,
		24,
		42
	],
	[
		6,
		26,
		46
	],
	[
		6,
		28,
		50
	],
	[
		6,
		30,
		54
	],
	[
		6,
		32,
		58
	],
	[
		6,
		34,
		62
	],
	[
		6,
		26,
		46,
		66
	],
	[
		6,
		26,
		48,
		70
	],
	[
		6,
		26,
		50,
		74
	],
	[
		6,
		30,
		54,
		78
	],
	[
		6,
		30,
		56,
		82
	],
	[
		6,
		30,
		58,
		86
	],
	[
		6,
		34,
		62,
		90
	],
	[
		6,
		28,
		50,
		72,
		94
	],
	[
		6,
		26,
		50,
		74,
		98
	],
	[
		6,
		30,
		54,
		78,
		102
	],
	[
		6,
		28,
		54,
		80,
		106
	],
	[
		6,
		32,
		58,
		84,
		110
	],
	[
		6,
		30,
		58,
		86,
		114
	],
	[
		6,
		34,
		62,
		90,
		118
	],
	[
		6,
		26,
		50,
		74,
		98,
		122
	],
	[
		6,
		30,
		54,
		78,
		102,
		126
	],
	[
		6,
		26,
		52,
		78,
		104,
		130
	],
	[
		6,
		30,
		56,
		82,
		108,
		134
	],
	[
		6,
		34,
		60,
		86,
		112,
		138
	],
	[
		6,
		30,
		58,
		86,
		114,
		142
	],
	[
		6,
		34,
		62,
		90,
		118,
		146
	],
	[
		6,
		30,
		54,
		78,
		102,
		126,
		150
	],
	[
		6,
		24,
		50,
		76,
		102,
		128,
		154
	],
	[
		6,
		28,
		54,
		80,
		106,
		132,
		158
	],
	[
		6,
		32,
		58,
		84,
		110,
		136,
		162
	],
	[
		6,
		26,
		54,
		82,
		110,
		138,
		166
	],
	[
		6,
		30,
		58,
		86,
		114,
		142,
		170
	]
];
/**
* 纠错等级 M 的分块参数：[每块纠错码字数, 块数]（下标 0 = 版本 1）。
* 数据码字数不列表，由「总码字 − 纠错码字」推导（见 numDataCodewords）。
*/
const ECC_M = [
	[10, 1],
	[16, 1],
	[26, 1],
	[18, 2],
	[24, 2],
	[16, 4],
	[18, 4],
	[22, 4],
	[22, 5],
	[26, 5],
	[30, 5],
	[22, 8],
	[22, 9],
	[24, 9],
	[24, 10],
	[28, 10],
	[28, 11],
	[26, 13],
	[26, 14],
	[26, 16],
	[26, 17],
	[28, 17],
	[28, 18],
	[28, 20],
	[28, 21],
	[28, 23],
	[28, 25],
	[28, 26],
	[28, 28],
	[28, 29],
	[28, 31],
	[28, 33],
	[28, 35],
	[28, 37],
	[28, 38],
	[28, 40],
	[28, 43],
	[28, 45],
	[28, 47],
	[28, 49]
];
const MAX_VERSION = 40;
/** GF(256) 乘法，本原多项式 0x11D。 */
function gfMul(a, b) {
	let z = 0;
	for (let i = 7; i >= 0; i -= 1) {
		z = (z << 1 ^ (z >>> 7) * 285) & 255;
		z ^= (b >>> i & 1) * a;
	}
	return z & 255;
}
/** 生成多项式 Π(x + α^i)，i = 0..degree-1；返回高次优先系数数组（首项恒为 1）。 */
function generatorPoly(degree) {
	let poly = [1];
	let root = 1;
	for (let i = 0; i < degree; i += 1) {
		const next = new Array(poly.length + 1).fill(0);
		for (let k = 0; k < poly.length; k += 1) {
			next[k] ^= gfMul(poly[k], root);
			next[k + 1] ^= poly[k];
		}
		poly = next;
		root = gfMul(root, 2);
	}
	return poly.reverse();
}
/** 计算 data 的 degree 字节 RS 校验码。 */
function rsRemainder(data, degree) {
	const gen = generatorPoly(degree);
	const buf = new Uint8Array(data.length + degree);
	buf.set(data, 0);
	for (let i = 0; i < data.length; i += 1) {
		const coef = buf[i];
		if (coef === 0) continue;
		for (let j = 1; j <= degree; j += 1) buf[i + j] ^= gfMul(gen[j], coef);
	}
	return buf.subarray(data.length);
}
/** 该版本可用于数据+纠错的码字总数（由几何推算，不查表）。 */
function totalCodewords(version) {
	let bits = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.floor(version / 7) + 2;
		bits -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) bits -= 36;
	}
	return Math.floor(bits / 8);
}
function numDataCodewords(version) {
	const [ecPerBlock, blocks] = ECC_M[version - 1];
	return totalCodewords(version) - ecPerBlock * blocks;
}
/** 字节模式的字符计数位宽。 */
function countBits(version) {
	return version < 10 ? 8 : 16;
}
/** 该版本字节模式可容纳的最大字节数。 */
function byteCapacity(version) {
	const usable = numDataCodewords(version) * 8 - 4 - countBits(version);
	return Math.floor(usable / 8);
}
/** 把比特数组（0/1）打包成字节数组，不足补 0。 */
function packBits(bits) {
	const out = new Uint8Array(Math.ceil(bits.length / 8));
	for (let i = 0; i < bits.length; i += 1) if (bits[i] === 1) out[i >>> 3] |= 128 >>> (i & 7);
	return out;
}
/** 生成完整码字流（数据 + 纠错，按标准交错）。 */
function buildCodewords(bytes, version) {
	const [ecPerBlock, blocks] = ECC_M[version - 1];
	const totalData = numDataCodewords(version);
	const bits = [];
	const push = (value, width) => {
		for (let i = width - 1; i >= 0; i -= 1) bits.push(value >>> i & 1);
	};
	push(4, 4);
	push(bytes.length, countBits(version));
	for (const byte of bytes) push(byte, 8);
	const capacityBits = totalData * 8;
	for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
	while (bits.length % 8 !== 0) bits.push(0);
	const packed = packBits(bits);
	const payload = new Uint8Array(totalData);
	payload.set(packed.subarray(0, Math.min(packed.length, totalData)), 0);
	for (let i = packed.length; i < totalData; i += 1) payload[i] = (i - packed.length) % 2 === 0 ? 236 : 17;
	const shortLen = Math.floor(totalData / blocks);
	const longBlocks = totalData % blocks;
	const dataBlocks = [];
	const ecBlocks = [];
	let offset = 0;
	for (let b = 0; b < blocks; b += 1) {
		const len = shortLen + (b >= blocks - longBlocks ? 1 : 0);
		const block = payload.subarray(offset, offset + len);
		offset += len;
		dataBlocks.push(block);
		ecBlocks.push(rsRemainder(block, ecPerBlock));
	}
	const out = [];
	for (let i = 0; i <= shortLen; i += 1) for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
	for (let i = 0; i < ecPerBlock; i += 1) for (const block of ecBlocks) out.push(block[i]);
	return Uint8Array.from(out);
}
function getBit(value, index) {
	return (value >>> index & 1) !== 0;
}
function alignCenters(version) {
	return ALIGN_CENTERS[version - 1];
}
/** 掩码函数（0..7），返回该位置是否取反。 */
function maskBit(mask, x, y) {
	switch (mask) {
		case 0: return (x + y) % 2 === 0;
		case 1: return y % 2 === 0;
		case 2: return x % 3 === 0;
		case 3: return (x + y) % 3 === 0;
		case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
		case 5: return x * y % 2 + x * y % 3 === 0;
		case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
		default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
	}
}
/** 15 位格式信息（BCH(15,5)，生成多项式 0x537，异或掩码 0x5412）。 */
function formatBits(mask) {
	const data = 0 | mask;
	let rem = data;
	for (let i = 0; i < 10; i += 1) rem = (rem << 1 ^ (rem >>> 9) * 1335) & 32767;
	return ((data << 10 | rem) ^ 21522) & 32767;
}
/** 18 位版本信息（BCH(18,6)，生成多项式 0x1F25）。 */
function versionBits(version) {
	let rem = version;
	for (let i = 0; i < 12; i += 1) rem = (rem << 1 ^ (rem >>> 11) * 7973) & 262143;
	return (version << 12 | rem) & 262143;
}
/** 掩码惩罚分（ISO 的四条规则），用于挑选最优掩码。 */
function penalty(modules, size) {
	let score = 0;
	const at = (x, y) => modules[y * size + x];
	for (let y = 0; y < size; y += 1) {
		let run = 1;
		for (let x = 1; x < size; x += 1) if (at(x, y) === at(x - 1, y)) run += 1;
		else {
			if (run >= 5) score += run - 2;
			run = 1;
		}
		if (run >= 5) score += run - 2;
	}
	for (let x = 0; x < size; x += 1) {
		let run = 1;
		for (let y = 1; y < size; y += 1) if (at(x, y) === at(x, y - 1)) run += 1;
		else {
			if (run >= 5) score += run - 2;
			run = 1;
		}
		if (run >= 5) score += run - 2;
	}
	for (let y = 0; y < size - 1; y += 1) for (let x = 0; x < size - 1; x += 1) {
		const v = at(x, y);
		if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
	}
	const seq1 = [
		1,
		0,
		1,
		1,
		1,
		0,
		1,
		0,
		0,
		0,
		0
	];
	const seq2 = seq1.slice().reverse();
	const matchesSeq = (x, y, dx, dy, seq) => {
		for (let k = 0; k < 11; k += 1) {
			const px = x + dx * k;
			const py = y + dy * k;
			if (px < 0 || py < 0 || px >= size || py >= size) return false;
			if (at(px, py) !== seq[k]) return false;
		}
		return true;
	};
	for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) for (const seq of [seq1, seq2]) {
		if (matchesSeq(x, y, 1, 0, seq)) score += 40;
		if (matchesSeq(x, y, 0, 1, seq)) score += 40;
	}
	let dark = 0;
	for (let i = 0; i < modules.length; i += 1) dark += modules[i];
	const percent = dark * 100 / (size * size);
	score += Math.floor(Math.abs(percent - 50) / 5) * 10;
	return score;
}
/**
* 编码文本为 QR 矩阵。
* @param {string} text 待编码内容（按 UTF-8 字节编码）
* @returns {{ size: number, data: Uint8Array }} 行优先矩阵，1 = 深色
*/
function encodeQr(text) {
	const bytes = new TextEncoder().encode(text);
	const version = chooseVersion(bytes.length);
	const size = version * 4 + 17;
	const codewords = buildCodewords(bytes, version);
	const modules = new Uint8Array(size * size);
	const isFunction = new Uint8Array(size * size);
	const setFn = (x, y, dark) => {
		modules[y * size + x] = dark ? 1 : 0;
		isFunction[y * size + x] = 1;
	};
	for (let i = 0; i < size; i += 1) {
		setFn(6, i, i % 2 === 0);
		setFn(i, 6, i % 2 === 0);
	}
	for (const [cx, cy] of [
		[3, 3],
		[size - 4, 3],
		[3, size - 4]
	]) for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
		const x = cx + dx;
		const y = cy + dy;
		if (x < 0 || y < 0 || x >= size || y >= size) continue;
		const d = Math.max(Math.abs(dx), Math.abs(dy));
		setFn(x, y, d !== 2 && d !== 4);
	}
	const centers = alignCenters(version);
	for (const cx of centers) for (const cy of centers) {
		if (cx === 6 && cy === 6 || cx === 6 && cy === size - 7 || cx === size - 7 && cy === 6) continue;
		for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
	}
	if (version >= 7) {
		const bits = versionBits(version);
		for (let i = 0; i < 18; i += 1) {
			const bit = getBit(bits, i) ? 1 : 0;
			const a = size - 11 + i % 3;
			const b = Math.floor(i / 3);
			setFn(a, b, bit);
			setFn(b, a, bit);
		}
	}
	for (let i = 0; i <= 5; i += 1) setFn(8, i, false);
	setFn(8, 7, false);
	setFn(8, 8, false);
	setFn(7, 8, false);
	for (let i = 9; i <= 14; i += 1) setFn(14 - i, 8, false);
	for (let i = 0; i <= 7; i += 1) setFn(size - 1 - i, 8, false);
	for (let i = 8; i <= 14; i += 1) setFn(8, size - 15 + i, false);
	setFn(8, size - 8, true);
	let bitIndex = 0;
	const totalBits = codewords.length * 8;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert += 1) for (let j = 0; j < 2; j += 1) {
			const x = right - j;
			const y = (right + 1 & 2) === 0 ? size - 1 - vert : vert;
			if (isFunction[y * size + x] === 1 || bitIndex >= totalBits) continue;
			const bit = codewords[bitIndex >>> 3] >>> 7 - (bitIndex & 7) & 1;
			modules[y * size + x] = bit;
			bitIndex += 1;
		}
	}
	let bestScore = Infinity;
	let bestData = null;
	for (let mask = 0; mask < 8; mask += 1) {
		const candidate = Uint8Array.from(modules);
		for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
			if (isFunction[y * size + x] === 1) continue;
			if (maskBit(mask, x, y)) candidate[y * size + x] ^= 1;
		}
		drawFormat(candidate, size, mask);
		const score = penalty(candidate, size);
		if (score < bestScore) {
			bestScore = score;
			bestData = candidate;
		}
	}
	return {
		size,
		data: bestData
	};
}
/** 写入两份格式信息 + 固定深色模块。 */
function drawFormat(modules, size, mask) {
	const bits = formatBits(mask);
	const put = (x, y, dark) => {
		modules[y * size + x] = dark ? 1 : 0;
	};
	for (let i = 0; i <= 5; i += 1) put(8, i, getBit(bits, i));
	put(8, 7, getBit(bits, 6));
	put(8, 8, getBit(bits, 7));
	put(7, 8, getBit(bits, 8));
	for (let i = 9; i <= 14; i += 1) put(14 - i, 8, getBit(bits, i));
	for (let i = 0; i <= 7; i += 1) put(size - 1 - i, 8, getBit(bits, i));
	for (let i = 8; i <= 14; i += 1) put(8, size - 15 + i, getBit(bits, i));
	put(8, size - 8, true);
}
function chooseVersion(byteLength) {
	for (let version = 1; version <= MAX_VERSION; version += 1) if (byteLength <= byteCapacity(version)) return version;
	throw new Error(`QR: 内容过长（${byteLength} 字节，字节模式上限 ${byteCapacity(MAX_VERSION)}）`);
}
//#endregion
export { encodeQr };
