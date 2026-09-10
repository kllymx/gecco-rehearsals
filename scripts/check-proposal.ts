import { checkExactProposal } from '../server/proposal-check.js';

const [candidateSha, prNumber, receiptPath] = process.argv.slice(2);
try {
  if (process.argv.length !== 5 || !receiptPath) throw new Error('Provide candidate SHA, PR number, and receipt path.');
  const result = await checkExactProposal({ cwd: process.cwd(), candidateSha, prNumber, receiptPath });
  console.log(JSON.stringify(result));
  process.exitCode = result.outcome === 'passed' ? 0 : 1;
} catch {
  console.error('Invalid proposal-check arguments or receipt could not be saved.');
  process.exitCode = 2;
}
