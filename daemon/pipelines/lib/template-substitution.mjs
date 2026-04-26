/**
 * Template substitution for daemon pipeline prompts.
 *
 * Replaces `{{VAR_NAME}}` tokens with the corresponding string from the
 * `variables` map. If a variable is missing the literal `{{VAR_NAME}}` token
 * is left in place AND a fallback line is also emitted via the optional
 * `onMissing` callback (used by daemon to log a warn).
 *
 * Story A.5: extracted from agent-daemon.mjs so the FEEDBACK substitution
 * round-trip can be unit-tested without spinning up a Claude subprocess.
 *
 * @param {string} template - the prompt template with {{VAR}} tokens.
 * @param {Record<string, string>} variables - flat name→value map.
 * @param {(varName: string) => void} [onMissing] - called once per missing var.
 * @returns {string}
 */
export function substituteTemplate(template, variables, onMissing) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    if (variables && Object.prototype.hasOwnProperty.call(variables, varName)) {
      const value = variables[varName];
      // Coerce non-string values defensively. Most pipeline values are already
      // strings (extractor output, captureAs output) but some initialVariables
      // could come in as numbers if the API ever passes them through.
      return value == null ? '' : String(value);
    }
    if (typeof onMissing === 'function') onMissing(varName);
    return match;
  });
}
