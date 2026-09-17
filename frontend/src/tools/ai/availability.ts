/**
 * Is a model/task installed? Pure, so it can be unit tested without pulling in
 * the viewer.
 */
import type { AiModelInfo } from '../../api/client';

export function availability(
  models: AiModelInfo[],
  modelId: string,
  taskId?: string,
): { available: boolean; reason?: string } {
  const m = models.find((x) => x.id === modelId);
  if (!m) return { available: false, reason: 'the backend does not list this model' };
  if (!m.available) return { available: false, reason: m.reason ?? 'not installed' };
  if (!taskId || !m.tasks.length) return { available: true };
  const t = m.tasks.find((x) => x.id === taskId);
  if (!t) return { available: false, reason: 'the backend does not list this task' };
  return { available: t.available !== false, reason: t.reason };
}
