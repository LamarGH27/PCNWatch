import type { NoticeType, ProceduralStage } from '@/core/reference/types';

/**
 * Where a notice places a case in the statutory process.
 *
 * A lookup, not a judgement. Each notice type has one meaning in the Traffic
 * Management Act process and that meaning is fixed, so this is a table rather
 * than something a model should be asked about.
 *
 * `UNKNOWN` maps to `UNKNOWN_STAGE` deliberately: a stage we cannot support
 * from the notice must not be displayed, because telling somebody they are in
 * the representation period when we do not know that is worse than telling
 * them nothing.
 */
const STAGE_FOR_NOTICE: Record<NoticeType, ProceduralStage> = {
  PCN_ON_STREET: 'NEW',
  PCN_POSTAL: 'NEW',
  NOTICE_TO_OWNER: 'NOTICE_TO_OWNER',
  NOTICE_OF_REJECTION: 'NOTICE_OF_REJECTION',
  NOTICE_OF_ACCEPTANCE: 'NOTICE_OF_ACCEPTANCE',
  // The stage model has no member for either of these. Rather than map them
  // onto the nearest one, they report no stage: a charge certificate is a
  // serious escalation and describing it as something else would be worse than
  // saying we cannot place it.
  CHARGE_CERTIFICATE: 'UNKNOWN_STAGE',
  ORDER_FOR_RECOVERY: 'UNKNOWN_STAGE',
  PRIVATE_PARKING_CHARGE: 'UNKNOWN_STAGE',
  UNKNOWN: 'UNKNOWN_STAGE',
};

export function stageForNoticeType(noticeType: NoticeType): ProceduralStage {
  return STAGE_FOR_NOTICE[noticeType] ?? 'UNKNOWN_STAGE';
}

/** Whether a stage is specific enough to show the user. */
export function isDisplayableStage(stage: ProceduralStage): boolean {
  return stage !== 'UNKNOWN_STAGE';
}
