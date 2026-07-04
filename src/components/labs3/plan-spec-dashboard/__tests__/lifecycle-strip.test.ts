import { describe, it, expect } from 'vitest';
import { activeStageIndex } from '../lifecycle-strip';

describe('activeStageIndex', () => {
  it('maps each status to its lifecycle stage', () => {
    expect(activeStageIndex('concept')).toBe(0);
    expect(activeStageIndex('developing')).toBe(1);
    expect(activeStageIndex('fixing')).toBe(1);
    expect(activeStageIndex('review')).toBe(2);
    expect(activeStageIndex('delivered')).toBe(3);
  });
  it('archived/unknown falls back to concept', () => {
    expect(activeStageIndex('archived' as never)).toBe(0);
  });
});
