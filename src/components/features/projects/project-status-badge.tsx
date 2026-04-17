import { cn } from '@/lib/utils';
import type { ProjectStatus } from '@/lib/validators/project';
import { projectStatusLabels } from '@/lib/validators/project';

const statusColors: Record<ProjectStatus, string> = {
  planning: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-yellow-100 text-yellow-800',
  complete: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-100 text-gray-600',
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        statusColors[status] ?? 'bg-gray-100 text-gray-800',
      )}
    >
      {projectStatusLabels[status] ?? status}
    </span>
  );
}
