/**
 * Bubble and screen effects: the name send_message takes, the expressive send style id Messages stores in chat.db and
 * sends with, and the label transcripts show.
 */
export const EFFECTS = [
  { name: 'slam', appleId: 'com.apple.MobileSMS.expressivesend.impact', label: 'slam' },
  { name: 'loud', appleId: 'com.apple.MobileSMS.expressivesend.loud', label: 'loud' },
  { name: 'gentle', appleId: 'com.apple.MobileSMS.expressivesend.gentle', label: 'gentle' },
  { name: 'invisible_ink', appleId: 'com.apple.MobileSMS.expressivesend.invisibleink', label: 'invisible ink' },
  { name: 'confetti', appleId: 'com.apple.messages.effect.CKConfettiEffect', label: 'confetti' },
  { name: 'fireworks', appleId: 'com.apple.messages.effect.CKFireworksEffect', label: 'fireworks' },
  { name: 'balloons', appleId: 'com.apple.messages.effect.CKHappyBirthdayEffect', label: 'balloons' },
  { name: 'lasers', appleId: 'com.apple.messages.effect.CKLasersEffect', label: 'lasers' },
  { name: 'love', appleId: 'com.apple.messages.effect.CKHeartEffect', label: 'love' },
  { name: 'celebration', appleId: 'com.apple.messages.effect.CKSparklesEffect', label: 'celebration' },
  { name: 'echo', appleId: 'com.apple.messages.effect.CKEchoEffect', label: 'echo' },
  { name: 'spotlight', appleId: 'com.apple.messages.effect.CKSpotlightEffect', label: 'spotlight' },
  { name: 'shooting_star', appleId: 'com.apple.messages.effect.CKShootingStarEffect', label: 'shooting star' },
] as const;

export type EffectName = (typeof EFFECTS)[number]['name'];

/** The effect names, in table order, as the tuple an enum schema needs. */
export const EFFECT_NAMES = EFFECTS.map((e) => e.name) as [EffectName, ...EffectName[]];

/** Other words people use for an effect, mapped to its name. */
export const EFFECT_ALIASES: Record<string, EffectName> = {
  impact: 'slam',
  invisible: 'invisible_ink',
  ink: 'invisible_ink',
  firework: 'fireworks',
  balloon: 'balloons',
  birthday: 'balloons',
  happy_birthday: 'balloons',
  laser: 'lasers',
  heart: 'love',
  hearts: 'love',
  sparkles: 'celebration',
  star: 'shooting_star',
  shootingstar: 'shooting_star',
};

const BY_NAME = new Map<string, (typeof EFFECTS)[number]>(EFFECTS.map((e) => [e.name, e]));
const BY_APPLE_ID = new Map<string, (typeof EFFECTS)[number]>(EFFECTS.map((e) => [e.appleId, e]));

/**
 * The style id Messages sends for an effect name; undefined for an unknown name.
 * @example effectAppleId('confetti') // 'com.apple.messages.effect.CKConfettiEffect'
 */
export const effectAppleId = (name: string) => BY_NAME.get(name)?.appleId;

/**
 * The transcript label for an effect name; undefined for an unknown name.
 * @example effectLabel('invisible_ink') // 'invisible ink'
 */
export const effectLabel = (name: string) => BY_NAME.get(name)?.label;

/**
 * The transcript label for a style id read from chat.db; undefined for anything that isn't an effect.
 * @example effectLabelForAppleId('com.apple.MobileSMS.expressivesend.impact') // 'slam'
 */
export const effectLabelForAppleId = (appleId: string) => BY_APPLE_ID.get(appleId)?.label;
