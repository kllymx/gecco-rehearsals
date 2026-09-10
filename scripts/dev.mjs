import { spawn } from 'node:child_process';
const children = [
  spawn('pnpm', ['dev:server'], { stdio: 'inherit' }),
  spawn('pnpm', ['dev:web'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 700).unref();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
for (const child of children) {
  child.on('error', (error) => { console.error(error); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code ?? 1); });
}
