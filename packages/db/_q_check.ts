import { PrismaClient } from './generated/index.js';
const p = new PrismaClient();
async function main() {
  const bookId = 'cmqzabimj005umw0vuaj5hm6y';
  const book = await p.book.findUnique({ where: { id: bookId }, select: { status: true, updated_at: true } });
  const chap = await p.chapter.count({ where: { book_id: bookId } });
  const failed = await p.job.findUnique({ where: { id: 'cmr0ems6q00azmw0v4efekt9w' }, select: { status: true, error: true } });
  const editor = await p.job.findFirst({ where: { book_id: bookId, kind: 'pipeline.book.editor' }, select: { status: true } });
  console.log('CHECK book.status=' + book?.status + ' chapters=' + chap + ' chapterJob=' + failed?.status + (failed?.error?'/'+failed.error.slice(0,50):'') + ' editorJob=' + (editor?.status ?? 'none'));
}
main().catch(e=>{console.error('FATAL',e.message);process.exit(1)}).finally(()=>p.$disconnect());
