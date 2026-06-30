import { z } from 'zod';

import { AssemblyFragmentType } from './enums';
import { FirestoreSchemaWithId } from '../../shared';

import type { FieldValue } from 'firebase-admin/firestore';

const FRAGMENT_DEFAULT_FILE_PATH = 'untitled-file';

// BASE SCHEMA
const baseFragmentSchema = z.object({
  title: z.string().default('Untitled Fragment'),
  language: z.string().default('plaintext'),
  filePath: z.string().default(FRAGMENT_DEFAULT_FILE_PATH),
  repoUrl: z.string().optional(),
  repoPath: z.string().optional(), // for local files
});

const codeFragmentSchema = baseFragmentSchema.extend({
  type: z.literal(AssemblyFragmentType.CODE),
  language: z.string().default('plaintext'),
  repo: z.string().optional(), // deprecated
});

const documentFragmentSchema = baseFragmentSchema.extend({
  type: z.literal(AssemblyFragmentType.DOCUMENTS),
  language: z.string().default('markdown'),
  repo: z.string().optional(), // deprecated
});

const htmlFragmentSchema = baseFragmentSchema.extend({
  type: z.literal(AssemblyFragmentType.HTML),
  language: z.string().default('html'),
});

const svgFragmentSchema = baseFragmentSchema.extend({
  type: z.literal(AssemblyFragmentType.SVG),
});

const mermaidFragmentSchema = baseFragmentSchema.extend({
  type: z.literal(AssemblyFragmentType.MERMAID),
});

// WITH ID
const WITH_SLUG = {
  slug: z.string().default(FRAGMENT_DEFAULT_FILE_PATH),
};
export const codeFragmentSchemaWithSlug = codeFragmentSchema.extend(WITH_SLUG);
export const documentFragmentSchemaWithSlug =
  documentFragmentSchema.extend(WITH_SLUG);
export const htmlFragmentSchemaWithSlug = htmlFragmentSchema.extend(WITH_SLUG);
export const svgFragmentSchemaWithSlug = svgFragmentSchema.extend(WITH_SLUG);
export const mermaidFragmentSchemaWithSlug =
  mermaidFragmentSchema.extend(WITH_SLUG);

// Type exports
export type CodeFragment = z.infer<typeof codeFragmentSchema>;
export type DocumentFragment = z.infer<typeof documentFragmentSchema>;
export type HTMLFragment = z.infer<typeof htmlFragmentSchema>;
export type SVGFragment = z.infer<typeof svgFragmentSchema>;
export type MermaidFragment = z.infer<typeof mermaidFragmentSchema>;
export type FragmentWithSlug = z.infer<
  | typeof codeFragmentSchemaWithSlug
  | typeof documentFragmentSchemaWithSlug
  | typeof htmlFragmentSchemaWithSlug
  | typeof svgFragmentSchemaWithSlug
  | typeof mermaidFragmentSchemaWithSlug
>; // Union of all fragment types with slug field
export type CreateFragmentPayload = FragmentWithSlug & {
  content: string;
}; // Union of all parsed fragment types
export type UpdateFragmentPayload = CreateFragmentPayload & {
  id: string; // the firestore id
};

export type FirestoreFragment = FragmentWithSlug & {
  content: string[];
  createdAt: FieldValue;
  updatedAt: FieldValue;
};
export type FirestoreFragmentWithId = FirestoreSchemaWithId<FirestoreFragment>;

export type StreamedFragment = FragmentWithSlug & {
  content: string;
  version: number; // 1-indexed
};

export type IndustryFragmentContent = {
  content: string;
  messageId?: string;
  toolCallId?: string;
};

export type IndustryFragment = FragmentWithSlug & {
  id: string;
  content: IndustryFragmentContent[]; // modify field name to 'version' once we no longer have fragments collection

  createdAt: number;
  updatedAt: number;
  isStreaming?: boolean;
};
