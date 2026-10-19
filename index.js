/**
 * Claude-DSH-Memory — Host-only Cordis plugin entry.
 *
 * The plugin registers `claude_memory_*` tools, a write guard for Claude memory
 * directories, a one-shot baseline injection per session, and the optional
 * post-turn extraction worker.
 */

export { apply } from './src/plugin.js'

/**
 * `tools` is a hard dependency: the whole plugin exists to register tools and a
 * guard. Every other service (`sessions`, `workingDirectory`, `llm`,
 * `agentDefaultModel`) is optional and probed at use time so the plugin still
 * mounts in a minimal profile.
 */
export const inject = ['tools']
