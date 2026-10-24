// 手动验证离线语音合成能不能出 wav（换机器后跑一次）
// 用法：node tools/check-tts.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCapabilities } from '../src/capabilities.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fftts-'));
const caps = createCapabilities({ cfg: { ttsEnabled: true, ttsMaxChars: 200 }, llm: { describeImage: async () => '' }, log: { event: () => {} }, dataDir });
try {
  const { file: wav } = await caps.speak('晚安呀，今天也辛苦啦');
  const size = fs.statSync(wav).size;
  const head = fs.readFileSync(wav).subarray(0, 4).toString('latin1');
  if (head !== 'RIFF') throw new Error(`产出的不是 wav（头是 ${head}）`);
  console.log('✅ 语音合成成功：', wav);
  console.log('   大小：', size, 'bytes');
} catch (e) {
  console.log('❌ 语音合成失败：', e.message);
  console.log('   提示：Windows 自带 SAPI 才可用；非 Windows 请改用外部 TTS 命令。');
  process.exit(1);
}
