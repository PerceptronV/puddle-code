import { request } from 'node:http';

const endpoint = process.env.PUDDLE_DESKTOP_ASKPASS_URL;
const token = process.env.PUDDLE_DESKTOP_ASKPASS_TOKEN;
const prompt = process.argv[2] ?? 'SSH authentication';
const kind =
  process.env.SSH_ASKPASS_PROMPT === 'confirm' || /\(yes\/no(?:\/[^)]+)?\)\??\s*$/i.test(prompt)
    ? 'confirm'
    : 'secret';

if (endpoint === undefined || token === undefined) process.exit(1);

const body = JSON.stringify({ prompt, kind });
const call = request(
  endpoint,
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  },
  (response) => {
    let result = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => (result += chunk));
    response.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(result);
        if (
          response.statusCode === 200 &&
          typeof parsed === 'object' &&
          parsed !== null &&
          'answer' in parsed &&
          typeof parsed.answer === 'string'
        ) {
          process.stdout.write(`${parsed.answer}\n`);
          return;
        }
      } catch {
        // A broken bridge is indistinguishable from cancellation to ssh.
      }
      process.exitCode = 1;
    });
  },
);
call.on('error', () => {
  process.exitCode = 1;
});
call.end(body);
