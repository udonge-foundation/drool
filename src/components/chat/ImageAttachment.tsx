/**
 * Component for displaying attached images in chat input
 */

import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { ImageStorageService } from '@/services/imageStorage';
import { ImageAttachment as ImageAttachmentType } from '@/types/types';

const MAX_VISIBLE_IMAGES = 3;
const MAX_TILE_WIDTH = 75; // Maximum width for each image tile
const DELETE_TEXT_WIDTH = 26; // Width of "Press Ctrl+D to remove all" text
const MARGIN_BUFFER = 4; // Extra margin buffer between tile and text

interface ImageAttachmentProps {
  images: ImageAttachmentType[];
  onRemove?: (imageId: string) => void;
  isProcessing?: boolean;
  width?: number;
}

export function ImageAttachment({
  images,
  onRemove,
  isProcessing,
  width = 80,
}: ImageAttachmentProps) {
  const { t } = useTranslation();

  if (images.length === 0 && !isProcessing) {
    return null;
  }

  const visibleImages = images.slice(0, MAX_VISIBLE_IMAGES);
  const hiddenCount = images.length - MAX_VISIBLE_IMAGES;

  // Helper function to truncate filename with ellipsis
  const truncateFilename = (filename: string, maxLength: number): string => {
    if (filename.length <= maxLength) return filename;
    return `${filename.substring(0, maxLength - 3)}...`;
  };

  // Calculate tile width dynamically to prevent overlap with "Press Ctrl+D" text
  const availableWidthForTile =
    images.length > 0 ? width - DELETE_TEXT_WIDTH - MARGIN_BUFFER : width;
  const tileWidth = Math.min(MAX_TILE_WIDTH, availableWidthForTile);

  // Calculate available width for filename based on tile width
  // Total width minus: [Image X] (11 chars) + [x] (3 chars) + spaces and borders (approx 10 chars)
  // Also account for file size display
  const maxFilenameLength = Math.max(20, tileWidth - 40);

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      paddingX={1}
      width={width}
    >
      <Box flexDirection="row">
        <Box flexDirection="column">
          {visibleImages.map((image) => (
            <Box key={image.id} width={tileWidth}>
              <Box
                borderStyle="round"
                borderColor={COLORS.text.info}
                paddingX={1}
                width={tileWidth}
              >
                <Box
                  flexDirection="row"
                  width="100%"
                  justifyContent="space-between"
                >
                  <Box flexDirection="row" flexGrow={1} flexShrink={1}>
                    <Box flexShrink={0}>
                      <Text color={COLORS.text.info}>
                        {t('common:imageAttachment.imageLabel', {
                          index: image.displayIndex,
                        })}
                      </Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text color={COLORS.text.muted} dimColor wrap="truncate">
                        {' '}
                        {truncateFilename(image.filename, maxFilenameLength)} (
                        {ImageStorageService.formatFileSize(image.size)})
                      </Text>
                    </Box>
                  </Box>
                  {onRemove && (
                    <Box flexShrink={0}>
                      <Text color={COLORS.error}>
                        {t('common:imageAttachment.removeButton')}
                      </Text>
                    </Box>
                  )}
                </Box>
              </Box>
            </Box>
          ))}
        </Box>

        {images.length > 0 && (
          <Box marginLeft={2} paddingTop={1}>
            <Text color={COLORS.text.muted} dimColor>
              {t('common:imageAttachment.removeAllHint')}
            </Text>
          </Box>
        )}
      </Box>

      {hiddenCount > 0 && (
        <Box>
          <Text color={COLORS.text.muted} dimColor>
            {t('common:imageAttachment.hiddenCount', { count: hiddenCount })}
          </Text>
        </Box>
      )}

      {isProcessing && (
        <Box>
          <Text color={COLORS.warning}>
            {t('common:imageAttachment.processing')}
          </Text>
        </Box>
      )}
    </Box>
  );
}
