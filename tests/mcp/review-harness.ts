/**
 * Test harness for tools whose apply must carry the planDigest of its preview. It does what a caller
 * does: preview first, then confirm with the digest the preview returned. The contract itself (refusal
 * without a digest, with a stale one) is tested directly in plan-binding.test.ts, not through this.
 */

type Handler = (input: any) => Promise<any>;

const BOUND_TOOLS = new Set([
    'restart_app',
    'update_app_settings',
    'update_app',
    'update_app_artifact',
    'rollback_app',
    'deploy_app',
    'deploy_jar',
]);

export function withReview(name: string, handler: Handler): Handler {
    if (!BOUND_TOOLS.has(name)) return handler;
    return async (input) => {
        if (!input.confirm || input.planDigest) return handler(input);
        const preview = await handler({ ...input, confirm: undefined, confirmProduction: undefined });
        let planDigest: string | undefined;
        try {
            // Where a caller finds it: the confirmation the preview asks for.
            planDigest = JSON.parse(preview.content[0].text).confirmation?.planDigest;
        } catch {
            // A preview that is not JSON (a plain message) has no digest to carry.
        }
        return handler(planDigest ? { ...input, planDigest } : input);
    };
}
