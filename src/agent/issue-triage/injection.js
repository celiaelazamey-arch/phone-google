/**
 * "Issue text is data, not instructions."
 *
 * Anyone can open an issue, so its body is untrusted input that reaches the same process that decides labels,
 * assignees and audit text. The scanner does not try to be a classifier of intent — it looks for the concrete
 * shapes that only make sense as an attempt to steer the agent (override phrasing, role-play, fake system turns,
 * secret exfiltration, deploy/merge commands, shell payloads, concealment), records what it found, and scrubs it
 * so the rest of the pipeline never reads the payload as evidence.
 *
 * Detecting an injection never raises confidence: it forces human review. A reporter who *legitimately* writes
 * "ignore the previous instructions" is rare, and a human reviewing a proposal is cheap.
 */
import { normalize } from './text.js';

export const INJECTION_RULES = Object.freeze([
  {
    id: 'override_ar',
    weight: 3,
    pattern: /(تجاهل|تخطي|انس|اطمس|الغ)\s+(كل\s+)?(التعليمات|الاوامر|السياق|القواعد|السياسه)/g
  },
  {
    id: 'override_en',
    weight: 3,
    pattern: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|system)\b[^.\n]{0,40}\b(instructions?|prompts?|rules?|messages?)\b/g
  },
  {
    id: 'role_play',
    weight: 2,
    // Arabic has no ASCII word boundaries, so the Arabic alternatives cannot sit inside `\b`.
    pattern: /(\b(you are now|from now on you|act as|pretend to be)\b|انت الان|اعتبر نفسك|تظاهر بانك)/g
  },
  { id: 'fake_system_turn', weight: 2, pattern: /(^|\n)\s*(system|developer|assistant|tool)\s*:/g },
  {
    id: 'secret_request',
    weight: 3,
    pattern: /(\b(print|show|reveal|dump|send)\b|اطبع|اكشف|ارسل|اعرض)[^.\n]{0,30}(\b(tokens?|secrets?|api keys?|passwords?)\b|مفتاح|توكن|اسرار|كلمه المرور)/g
  },
  {
    id: 'deploy_command',
    weight: 3,
    pattern: /\b(merge|push|deploy|release|publish)\b[^.\n]{0,30}\b(main|master|production|prod)\b|(ادمج|دفع|انشر|اطلق)\s+(الي\s+)?(main|الانتاج|الفرع الرئيسي)/g
  },
  { id: 'shell_payload', weight: 3, pattern: /(rm\s+-rf\s+|curl\s+[^|\n]{0,60}\|\s*(bash|sh)|wget\s+[^|\n]{0,60}\|\s*(bash|sh)|sudo\s+|powershell\s+-enc)/g },
  { id: 'concealment', weight: 2, pattern: /(لا\s+تبلغ|لا\s+تخبر|دون\s+ابلاغ|بدون\s+علم\s+المالك|do not (tell|notify|report|log)|hide this)/g },
  { id: 'encoded_blob', weight: 1, pattern: /[a-z0-9+/]{160,}={0,2}/g }
]);

/**
 * Scan untrusted text. Returns the rule ids that fired, a scrubbed copy to continue with, and a weight score
 * the gate uses to justify human review.
 */
export function scanForInjection(...parts) {
  const source = parts.map((part) => String(part ?? ''));
  const raw = source.filter(Boolean).join('\n');
  const haystack = normalize(raw);
  const matches = [];
  for (const rule of INJECTION_RULES) {
    rule.pattern.lastIndex = 0;
    let hit = rule.pattern.exec(haystack);
    while (hit) {
      matches.push({ id: rule.id, weight: rule.weight, value: hit[0].trim() });
      if (!rule.pattern.global) break;
      hit = rule.pattern.exec(haystack);
    }
    rule.pattern.lastIndex = 0;
  }
  const score = matches.reduce((total, match) => total + match.weight, 0);
  return {
    tainted: matches.length > 0,
    score,
    ruleIds: [...new Set(matches.map((match) => match.id))],
    /** The literal payload is kept only so the audit can say what was refused; it is never shown to a classifier. */
    payloads: matches.slice(0, 5).map((match) => ({ id: match.id, value: match.value.slice(0, 60) })),
    scrubbed: scrub(haystack),
    /** Same scrub applied per input part, so classification can keep title weight separate from body weight. */
    scrubbedParts: source.map((part) => scrub(normalize(part)))
  };
}

/** Replace every injection span so downstream keyword scoring cannot be steered by attacker text. */
export function scrub(normalizedText) {
  let out = normalizedText;
  for (const rule of INJECTION_RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, ' [ignored] ');
    rule.pattern.lastIndex = 0;
  }
  return out.replace(/\s+/g, ' ').trim();
}
