import { readFile } from 'node:fs/promises'

const [answer, source] = await Promise.all([
  readFile('answer.txt', 'utf8'),
  readFile('input.txt', 'utf8'),
])
if (source !== 'forty-two\n' || answer !== '42\n') process.exitCode = 1
