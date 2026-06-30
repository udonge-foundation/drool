import { z } from 'zod';

import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';

import {
  WIKI_MAX_PAGES,
  WIKI_MAX_PAGE_CONTENT_LENGTH,
  WIKI_MAX_PAGE_TREE_DEPTH,
  WIKI_MAX_IMAGE_SIZE,
  WIKI_MAX_TOTAL_IMAGES_SIZE,
  WIKI_MAX_IMAGE_COUNT,
  WIKI_SUPPORTED_IMAGE_TYPES,
  WIKI_VIDEO_MAX_BYTES,
  WIKI_VIDEO_CONTENT_TYPE,
  WIKI_VIDEO_CAPTION_MAX_BYTES,
  WIKI_VIDEO_CAPTION_CONTENT_TYPE,
} from './constants';
import { SessionPrivacyLevel } from '../../../session/enums';

/**
 * Schema for a single page tree node (recursive, with depth validation)
 */

const PageTreeNodeSchema: z.ZodType = z.object({
  pageId: z.string().min(1, 'pageId is required'),
  title: z.string().min(1, 'title is required'),
  path: z.string().min(1, 'path is required'),
  order: z.number().int().min(0),
  children: z.lazy(() => z.array(PageTreeNodeSchema)),
});

/**
 * Validates that a page tree does not exceed the maximum depth
 */
function validatePageTreeDepth(
  nodes: z.infer<typeof PageTreeNodeSchema>[],
  currentDepth: number
): boolean {
  if (currentDepth > WIKI_MAX_PAGE_TREE_DEPTH) {
    return false;
  }
  for (const node of nodes) {
    if (
      node.children &&
      node.children.length > 0 &&
      !validatePageTreeDepth(node.children, currentDepth + 1)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Schema for a single wiki page in the create request
 */
const WikiPageSchema = z.object({
  pageId: z.string().min(1, 'pageId is required'),
  path: z.string().min(1, 'path is required'),
  title: z.string().min(1, 'title is required'),
  content: z
    .string()
    .max(
      WIKI_MAX_PAGE_CONTENT_LENGTH,
      `Page content must not exceed ${WIKI_MAX_PAGE_CONTENT_LENGTH} characters (500KB)`
    ),
  order: z.number().int().min(0),
});

/**
 * Schema for model information
 */
const ModelUsedSchema = z.object({
  id: z.string().min(1),
  reasoningEffort: z.nativeEnum(ReasoningEffort),
});

/**
 * Schema for a single wiki image in the create request.
 * Validates path (no traversal/absolute/null bytes), base64 data,
 * supported content type, and per-image size limit.
 */
export const WikiImageSchema = z.object({
  path: z
    .string()
    .min(1, 'Image path is required')
    .refine((p) => !p.includes('..'), {
      message: 'Image path must not contain directory traversal (..)',
    })
    .refine((p) => !p.startsWith('/'), {
      message: 'Image path must not be absolute',
    })
    .refine((p) => !p.includes('\x00'), {
      message: 'Image path must not contain null bytes',
    }),
  data: z
    .string()
    .min(1, 'Image data is required')
    .max(
      Math.ceil(WIKI_MAX_IMAGE_SIZE / 3) * 4,
      `Image data must not exceed the base64 length for ${WIKI_MAX_IMAGE_SIZE} bytes`
    ),
  contentType: z.enum(WIKI_SUPPORTED_IMAGE_TYPES, {
    errorMap: () => ({
      message: `Unsupported image type. Supported types: ${WIKI_SUPPORTED_IMAGE_TYPES.join(', ')}`,
    }),
  }),
  sizeBytes: z
    .number()
    .int()
    .min(1, 'Image size must be at least 1 byte')
    .max(
      WIKI_MAX_IMAGE_SIZE,
      `Image size must not exceed ${WIKI_MAX_IMAGE_SIZE} bytes (5MB)`
    ),
});

/**
 * Schema for wiki video overview metadata.
 *
 * When `status` is `'ready'`, all fields describing the video artifact
 * (`s3Key`, `sizeBytes`, `contentType`, `generatedAt`, `durationSeconds`,
 * `captionTracks`) are present. For `'failed'` or `'skipped'`, only `status`
 * and `warnings` are required.
 */
const WikiVideoCaptionLanguageSchema = z
  .string()
  .regex(
    /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/,
    'language must be a lowercase BCP 47 language tag'
  );

export const WikiVideoCaptionTrackMetadataSchema = z.object({
  language: WikiVideoCaptionLanguageSchema,
  label: z.string().min(1, 'label is required').max(80),
  s3Key: z.string().min(1, 's3Key is required'),
  sizeBytes: z
    .number()
    .int()
    .min(1, 'caption sizeBytes must be at least 1 byte')
    .max(
      WIKI_VIDEO_CAPTION_MAX_BYTES,
      `caption sizeBytes must not exceed ${WIKI_VIDEO_CAPTION_MAX_BYTES} bytes (1MB)`
    ),
  contentType: z.literal(WIKI_VIDEO_CAPTION_CONTENT_TYPE),
});

const WikiVideoCaptionTrackResponseSchema =
  WikiVideoCaptionTrackMetadataSchema.extend({
    playbackUrl: z
      .string()
      .min(1, 'caption playbackUrl is required when status is ready'),
  });

const WikiVideoUploadCaptionTrackRequestSchema = z.object({
  language: WikiVideoCaptionLanguageSchema,
  label: z.string().min(1, 'label is required').max(80),
  contentType: z.literal(WIKI_VIDEO_CAPTION_CONTENT_TYPE, {
    errorMap: () => ({
      message: `caption contentType must be '${WIKI_VIDEO_CAPTION_CONTENT_TYPE}'`,
    }),
  }),
  sizeBytes: z
    .number()
    .int('caption sizeBytes must be an integer')
    .min(1, 'caption sizeBytes must be at least 1 byte')
    .max(
      WIKI_VIDEO_CAPTION_MAX_BYTES,
      `caption sizeBytes must not exceed ${WIKI_VIDEO_CAPTION_MAX_BYTES} bytes (1MB)`
    ),
});

const WikiVideoUploadCaptionTracksRequestSchema = z
  .array(WikiVideoUploadCaptionTrackRequestSchema)
  .min(1, 'At least one caption track is required')
  .max(5, 'At most 5 caption tracks are supported')
  .superRefine((tracks, ctx) => {
    const seen = new Set<string>();
    tracks.forEach((track, index) => {
      if (seen.has(track.language)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'language'],
          message: 'Duplicate caption track languages are not allowed',
        });
      }
      seen.add(track.language);
    });
  });

export const WikiVideoOverviewMetadataSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    s3Key: z.string().min(1, 's3Key is required when status is ready'),
    sizeBytes: z
      .number()
      .int()
      .min(1, 'sizeBytes must be at least 1 byte')
      .max(
        WIKI_VIDEO_MAX_BYTES,
        `sizeBytes must not exceed ${WIKI_VIDEO_MAX_BYTES} bytes (100MB)`
      ),
    contentType: z.literal(WIKI_VIDEO_CONTENT_TYPE),
    generatedAt: z
      .string()
      .min(1, 'generatedAt is required when status is ready'),
    durationSeconds: z.number().min(0, 'durationSeconds must be non-negative'),
    captionTracks: z
      .array(WikiVideoCaptionTrackMetadataSchema)
      .min(1, 'At least one caption track is required'),
    warnings: z.array(z.string()),
  }),
  z.object({
    status: z.literal('failed'),
    s3Key: z.string().optional(),
    sizeBytes: z.number().int().optional(),
    contentType: z.literal(WIKI_VIDEO_CONTENT_TYPE).optional(),
    generatedAt: z.string().optional(),
    durationSeconds: z.number().optional(),
    captionTracks: z.array(WikiVideoCaptionTrackMetadataSchema).optional(),
    warnings: z.array(z.string()),
  }),
  z.object({
    status: z.literal('skipped'),
    s3Key: z.string().optional(),
    sizeBytes: z.number().int().optional(),
    contentType: z.literal(WIKI_VIDEO_CONTENT_TYPE).optional(),
    generatedAt: z.string().optional(),
    durationSeconds: z.number().optional(),
    captionTracks: z.array(WikiVideoCaptionTrackMetadataSchema).optional(),
    warnings: z.array(z.string()),
  }),
]);

/**
 * Schema for the video overview in GET responses.
 * When `status === 'ready'`, includes a presigned `playbackUrl`.
 */
export const WikiVideoOverviewResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    s3Key: z.string(),
    sizeBytes: z.number().int(),
    contentType: z.literal(WIKI_VIDEO_CONTENT_TYPE),
    generatedAt: z.string(),
    durationSeconds: z.number(),
    captionTracks: z
      .array(WikiVideoCaptionTrackResponseSchema)
      .min(1, 'At least one caption track is required'),
    warnings: z.array(z.string()),
    playbackUrl: z
      .string()
      .min(1, 'playbackUrl is required when status is ready'),
  }),
  z.object({
    status: z.literal('failed'),
    s3Key: z.string().optional(),
    sizeBytes: z.number().int().optional(),
    contentType: z.literal(WIKI_VIDEO_CONTENT_TYPE).optional(),
    generatedAt: z.string().optional(),
    durationSeconds: z.number().optional(),
    captionTracks: z.array(WikiVideoCaptionTrackMetadataSchema).optional(),
    warnings: z.array(z.string()),
  }),
  z.object({
    status: z.literal('skipped'),
    s3Key: z.string().optional(),
    sizeBytes: z.number().int().optional(),
    contentType: z.literal(WIKI_VIDEO_CONTENT_TYPE).optional(),
    generatedAt: z.string().optional(),
    durationSeconds: z.number().optional(),
    captionTracks: z.array(WikiVideoCaptionTrackMetadataSchema).optional(),
    warnings: z.array(z.string()),
  }),
]);

/**
 * Schema for POST /api/v0/wiki/video-upload-url - Request
 */
export const WikiVideoUploadUrlRequestSchema = z.object({
  /**
   * Optional UUID minted by the caller to identify this wiki run end-to-end.
   * When provided, the backend signs the upload URL using this id (so the
   * caller can re-use the same id when subsequently calling POST /api/v0/wiki).
   * The backend rejects the request with 409 Conflict if a wiki run with this
   * id already exists for the org. When omitted, the backend mints one.
   */
  wikiRunId: z.string().uuid('wikiRunId must be a valid UUID').optional(),
  repoUrl: z.string().min(1, 'repoUrl is required'),
  video: z.object({
    contentType: z.literal(WIKI_VIDEO_CONTENT_TYPE, {
      errorMap: () => ({
        message: `contentType must be '${WIKI_VIDEO_CONTENT_TYPE}'`,
      }),
    }),
    sizeBytes: z
      .number()
      .int('sizeBytes must be an integer')
      .min(1, 'sizeBytes must be at least 1 byte')
      .max(
        WIKI_VIDEO_MAX_BYTES,
        `sizeBytes must not exceed ${WIKI_VIDEO_MAX_BYTES} bytes (100MB)`
      ),
  }),
  captionTracks: WikiVideoUploadCaptionTracksRequestSchema,
});

/**
 * Schema for POST /api/v0/wiki/video-upload-url - Response
 */
export const WikiVideoUploadUrlResponseSchema = z.object({
  wikiRunId: z.string().min(1),
  video: z.object({
    uploadUrl: z.string().min(1),
    s3Key: z.string().min(1),
    expiresAt: z.number().int(),
    maxBytes: z.number().int(),
    contentType: z.literal(WIKI_VIDEO_CONTENT_TYPE),
  }),
  captionTracks: z
    .array(
      z.object({
        language: WikiVideoCaptionLanguageSchema,
        label: z.string().min(1).max(80),
        uploadUrl: z.string().min(1),
        s3Key: z.string().min(1),
        expiresAt: z.number().int(),
        maxBytes: z.number().int(),
        contentType: z.literal(WIKI_VIDEO_CAPTION_CONTENT_TYPE),
      })
    )
    .min(1),
});

/**
 * Schema for POST /api/v0/wiki - Create wiki run request
 */
export const CreateWikiRunRequestSchema = z
  .object({
    sessionId: z.string().min(1, 'sessionId is required').optional(),
    repoUrl: z.string().min(1, 'repoUrl is required'),
    commitHash: z.string().min(1, 'commitHash is required'),
    branch: z.string().min(1, 'branch is required'),
    hasLocalChanges: z.boolean(),
    hasNonRemoteCommits: z.boolean(),
    modelUsed: ModelUsedSchema.optional(),
    droolVersion: z.string().optional(),
    /** Reserved wikiRunId from the video-upload-url reservation endpoint */
    wikiRunId: z.string().min(1, 'wikiRunId must be non-empty').optional(),
    /** Video overview metadata to persist on the wiki run */
    videoOverview: WikiVideoOverviewMetadataSchema.optional(),
    /**
     * Copy video overview from an existing wiki run instead of uploading a new video.
     * When set, the backend resolves the source run's video metadata server-side,
     * verifies access, and re-references the same S3 object on the new run.
     * Mutually exclusive with `videoOverview`.
     */
    copyFromWikiRunId: z
      .string()
      .min(1, 'copyFromWikiRunId must be non-empty')
      .optional(),
    pages: z
      .array(WikiPageSchema)
      .min(1, 'At least one page is required')
      .max(
        WIKI_MAX_PAGES,
        `Pages array must not exceed ${WIKI_MAX_PAGES} entries`
      ),
    pageTree: z
      .array(PageTreeNodeSchema)
      .min(1, 'Page tree must have at least one node')
      .refine((nodes) => validatePageTreeDepth(nodes, 1), {
        message: `Page tree must not exceed ${WIKI_MAX_PAGE_TREE_DEPTH} levels of depth`,
      }),
    images: z
      .array(WikiImageSchema)
      .max(
        WIKI_MAX_IMAGE_COUNT,
        `Images array must not exceed ${WIKI_MAX_IMAGE_COUNT} entries`
      )
      .refine(
        (images) => {
          const totalSize = images.reduce((sum, img) => sum + img.sizeBytes, 0);
          return totalSize <= WIKI_MAX_TOTAL_IMAGES_SIZE;
        },
        {
          message: `Total image size must not exceed ${WIKI_MAX_TOTAL_IMAGES_SIZE} bytes (50MB)`,
        }
      )
      .refine(
        (images) => {
          const paths = images.map((img) => img.path);
          return new Set(paths).size === paths.length;
        },
        {
          message: 'Duplicate image paths are not allowed',
        }
      )
      .optional(),
  })
  .refine((data) => !(data.copyFromWikiRunId && data.videoOverview), {
    path: ['copyFromWikiRunId'],
    message: 'copyFromWikiRunId and videoOverview are mutually exclusive',
  });

/**
 * Schema for POST /api/v0/wiki - Create wiki run response
 */
export const CreateWikiRunResponseSchema = z.object({
  wikiRunId: z.string(),
});

/**
 * Schema for a wiki run in list responses (without page content)
 */
export const WikiRunSummarySchema = z.object({
  wikiRunId: z.string(),
  createdAt: z.number().int(),
  sourceSessionId: z.string().optional(),
  ownerUserId: z.string().optional(),
  repoUrl: z.string(),
  commitHash: z.string(),
  branch: z.string(),
  hasLocalChanges: z.boolean(),
  hasNonRemoteCommits: z.boolean(),
  modelUsed: ModelUsedSchema.optional(),
  droolVersion: z.string().optional(),
  privacyLevel: z.nativeEnum(SessionPrivacyLevel).optional(),
  isRepoCoveredByOrgIntegration: z.boolean().optional(),
  canUpdatePrivacy: z.boolean().optional(),
  pageCount: z.number().int(),
  pageTree: z.array(PageTreeNodeSchema),
});

/**
 * Schema for GET /api/v0/wiki - List latest wiki runs response
 */
export const ListWikiRunsResponseSchema = z.object({
  wikiRuns: z.array(WikiRunSummarySchema),
});

/**
 * Schema for GET /api/v0/wiki/[wikiRunId] - Get wiki run response
 * Same shape as WikiRunSummarySchema plus optional videoOverview
 */
export const GetWikiRunResponseSchema = z.object({
  wikiRunId: z.string(),
  createdAt: z.number().int(),
  sourceSessionId: z.string().optional(),
  ownerUserId: z.string().optional(),
  repoUrl: z.string(),
  commitHash: z.string(),
  branch: z.string(),
  hasLocalChanges: z.boolean(),
  hasNonRemoteCommits: z.boolean(),
  modelUsed: ModelUsedSchema.optional(),
  droolVersion: z.string().optional(),
  privacyLevel: z.nativeEnum(SessionPrivacyLevel).optional(),
  isRepoCoveredByOrgIntegration: z.boolean().optional(),
  canUpdatePrivacy: z.boolean().optional(),
  pageCount: z.number().int(),
  pageTree: z.array(PageTreeNodeSchema),
  /** Video overview with playbackUrl when status is 'ready' */
  videoOverview: WikiVideoOverviewResponseSchema.optional(),
});

/**
 * Schema for GET /api/v0/wiki/[wikiRunId]/pages/[pageId] - Get wiki page response
 */
export const GetWikiPageResponseSchema = z.object({
  pageId: z.string(),
  path: z.string(),
  title: z.string(),
  content: z.string(),
  order: z.number().int(),
});

/**
 * Schema for GET /api/v0/wiki/history/[repoUrl] - List wiki run history response
 */
export const ListWikiRunHistoryResponseSchema = z.object({
  wikiRuns: z.array(WikiRunSummarySchema),
});

/**
 * Schema for GET /api/v0/wiki/[wikiRunId]/search - Search query parameters
 */
export const WikiSearchQuerySchema = z.object({
  q: z.string().min(1, 'Search query must not be empty'),
  limit: z
    .number()
    .int('Limit must be an integer')
    .min(1, 'Limit must be at least 1')
    .max(100, 'Limit must be at most 100')
    .default(20),
});

/**
 * Schema for a single search result
 */
export const WikiSearchResultSchema = z.object({
  pageId: z.string(),
  title: z.string(),
  path: z.string(),
  snippet: z.string(),
  matchCount: z.number().int(),
});

/**
 * Schema for GET /api/v0/wiki/[wikiRunId]/search - Search response
 */
export const WikiSearchResponseSchema = z.object({
  results: z.array(WikiSearchResultSchema),
});

/**
 * Schema for GET /api/v0/wiki/[wikiRunId]/export - Export response
 */
export const WikiExportResponseSchema = z.object({
  url: z.string(),
});

/**
 * Schema for DELETE /api/v0/wiki/[wikiRunId] - Delete wiki run response
 */
export const DeleteWikiRunResponseSchema = z.object({
  deleted: z.literal(true),
});
