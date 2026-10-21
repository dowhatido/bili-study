import { lstat, mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PROJECT_ROOT, inspectRuntime, isMain } from './check.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    // zip/unzip diagnostics may include paths; do not echo subprocess output.
    throw new Error(`${command} 执行失败；请确认系统已安装该工具。现有产物保持不变。`);
  }
  return result.stdout;
}

export async function packageRuntime() {
  const snapshot = await inspectRuntime();
  const output = path.join(PROJECT_ROOT, 'output');
  await mkdir(output, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const outputStat = await lstat(output);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) throw new Error('output 必须是项目内的真实目录，不能是符号链接。');
  // Unique directory and exclusive writes: no cleanup, deletion, or overwrite of prior artifacts.
  const destination = await mkdtemp(path.join(output, `bili-study-${snapshot.version}-`));
  const staging = path.join(destination, 'snapshot');
  const unpacked = path.join(destination, 'extension');
  await mkdir(staging);
  const names = [...snapshot.files.keys()].sort();
  for (const name of names) {
    const target = path.join(staging, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, snapshot.files.get(name), { flag: 'wx', mode: 0o644 });
  }
  const archive = path.join(destination, `bili-study-${snapshot.version}.zip`);
  run('zip', ['-X', '-q', archive, '-@'], { cwd: staging, input: `${names.join('\n')}\n` });
  run('unzip', ['-tqq', archive]);
  const entries = run('unzip', ['-Z1', archive]).trim().split('\n').sort();
  if (JSON.stringify(entries) !== JSON.stringify(names)) throw new Error('ZIP 文件清单与运行白名单不一致；未删除失败产物。');
  // Extract the actual archive, not merely the pre-archive snapshot, before reporting loadability.
  await mkdir(unpacked);
  run('unzip', ['-q', archive, '-d', unpacked]);
  for (const name of names) {
    const archived = run('unzip', ['-p', archive, name], { encoding: 'buffer' });
    if (digest(archived) !== digest(snapshot.files.get(name))) throw new Error(`ZIP 内容校验失败：${name}；未删除失败产物。`);
    if (digest(await readFile(path.join(unpacked, ...name.split('/')))) !== digest(snapshot.files.get(name))) {
      throw new Error(`解压目录内容校验失败：${name}；未删除失败产物。`);
    }
  }
  return { archive, unpacked, version: snapshot.version, fileCount: names.length };
}

if (isMain(import.meta.url)) {
  try {
    const result = await packageRuntime();
    console.log(`打包及逐文件 SHA-256 校验通过：v${result.version}，${result.fileCount} 个运行文件。`);
    console.log(`ZIP：${result.archive}`);
    console.log(`可加载目录：${result.unpacked}`);
    console.log('白名单不包含凭据文件、.git、output、tests、scripts、package.json 或项目文档；未删除或覆盖旧产物。');
  } catch (error) {
    console.error(`打包失败：${error.message}`);
    process.exitCode = 1;
  }
}
