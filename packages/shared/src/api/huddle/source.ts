import { z } from 'zod';
import { huddleDocumentSchema, huddleOpenSchema } from './authoring.js';
import { huddleDefinitionSchema, huddleLayoutSchema } from './definitions.js';
import { HUDDLE_LIMITS, huddleRelativePathSchema } from './values.js';

const encoder = new TextEncoder();
const sourceText = z
  .string()
  .max(HUDDLE_LIMITS.fileBytes)
  .refine(
    (text) => encoder.encode(text).byteLength <= HUDDLE_LIMITS.fileBytes,
    'Huddle source file exceeds its byte limit',
  )
  .refine(
    (text) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoder.encode(text)) === text,
    'Huddle source must be lossless UTF-8 text',
  );
/** Validation does not normalise the source that is published. */
export const huddleTextEditSchema = z
  .strictObject({
    file: z.enum(['huddle.json', 'layout.json']),
    content: sourceText,
  })
  .superRefine((edit, ctx) => {
    try {
      const schema = edit.file === 'huddle.json' ? huddleDefinitionSchema : huddleLayoutSchema;
      schema.parse(JSON.parse(edit.content));
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Source must be a supported huddle JSON document without unknown fields',
      });
    }
  });
export type HuddleTextEdit = z.infer<typeof huddleTextEditSchema>;
export const huddleSaveSourceSchema = huddleOpenSchema.extend({
  expected_digest: z.string().regex(/^[a-f0-9]{64}$/),
  edit: huddleTextEditSchema,
});
export type HuddleSaveSource = z.infer<typeof huddleSaveSourceSchema>;

/** One capture supplies both the exact source and its whole-closure digest. */
export const huddleSourceSchema = z.strictObject({
  document: huddleDocumentSchema,
  files: z.record(huddleRelativePathSchema, sourceText).superRefine((files, ctx) => {
    if (
      Object.keys(files).length > HUDDLE_LIMITS.files ||
      Object.values(files).reduce((bytes, text) => bytes + encoder.encode(text).byteLength, 0) >
        HUDDLE_LIMITS.bundleBytes
    )
      ctx.addIssue({ code: 'custom', message: 'Huddle source capture exceeds its limits' });
    if (!Object.hasOwn(files, 'huddle.json'))
      ctx.addIssue({ code: 'custom', message: 'Huddle source capture requires its manifest' });
  }),
});
export type HuddleSource = z.infer<typeof huddleSourceSchema>;
