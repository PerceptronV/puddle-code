// A deliberate runner entry point so standalone daemon archives resolve zod
// without depending on the development checkout's node_modules.
export * from 'zod';
export { default } from 'zod';
