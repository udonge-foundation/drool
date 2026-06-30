import { z } from 'zod';

const jsonRenderElementSchema = z
  .object({
    type: z.string(),
    props: z.record(z.unknown()),
    children: z.array(z.string()).optional(),
  })
  .passthrough();

export const jsonRenderSpecSchema = z
  .object({
    root: z.string().min(1),
    state: z.record(z.unknown()).optional(),
    elements: z.record(jsonRenderElementSchema),
  })
  .passthrough()
  .refine(
    (spec) => Object.prototype.hasOwnProperty.call(spec.elements, spec.root),
    { message: 'root element must exist in elements map' }
  );
