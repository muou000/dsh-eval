import { writeFile } from 'node:fs/promises'

const task = process.argv[2]
if (typeof task !== 'string' || task.length === 0) throw new Error('task argument is required')
const answer = process.env.ANSWER
if (answer !== '41' && answer !== '42') throw new Error('ANSWER must select a frozen example variant')

await writeFile('answer.txt', `${answer}\n`, 'utf8')
await writeFile('run.json', `${JSON.stringify({ task, answer })}\n`, 'utf8')
