import { ResourceMonitorService } from '@/services/ResourceMonitorService';

// Singleton instance
let resourceMonitorInstance: ResourceMonitorService | null = null;

export function getResourceMonitorService(): ResourceMonitorService {
  if (!resourceMonitorInstance) {
    resourceMonitorInstance = new ResourceMonitorService();
  }
  return resourceMonitorInstance;
}
