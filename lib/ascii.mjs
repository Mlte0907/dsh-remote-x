// 把 ffmpeg 输出的 rawvideo(rgb24) 渲染成 ASCII 缩略图，用于在无法直读图片时感知布局。
import { readFileSync, writeFileSync } from 'node:fs'

const [w, h, outPath] = process.argv.slice(2)
const buf = readFileSync(0) // 从 stdin 读整段 raw
const W = Number(w), H = Number(h)
const ramp = ' .:-=+*#%@'
const lines = []
for (let y = 0; y < H; y++) {
  let line = ''
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3
    const r = buf[i], g = buf[i + 1], b = buf[i + 2]
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    line += ramp[Math.min(ramp.length - 1, Math.floor(lum * ramp.length))]
  }
  lines.push(line)
}
const text = lines.join('\n')
if (outPath) writeFileSync(outPath, text + '\n')
else process.stdout.write(text + '\n')
