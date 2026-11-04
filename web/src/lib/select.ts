// Re-export of the server's SELECT splitter, so the table's column edits split exactly as the
// server does (commas inside parentheses or quotes do not separate columns).
export { splitSelect } from '../../../server/src/query/build.ts';
