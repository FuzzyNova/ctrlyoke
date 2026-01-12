# Codex CLI Configuration Reference

**Source**: [Codex Documentation - Config](https://github.com/openai/codex/blob/main/docs/config.md#observability-and-telemetry)

**Status**: ✅ Notify hook feature implemented  
**Implementation**: See [CODEX_COMPLETION_DETECTION.md](CODEX_COMPLETION_DETECTION.md) for FlightPath's implementation  
**Integration**: `CodexCommandLineIntegration.ts` uses the `notify` configuration option

---

This document contains reference material from the official Codex documentation about configuration options. FlightPath uses the **notify hook** for completion detection. The OTEL (OpenTelemetry) features are documented here for future reference.

---

## Config

Codex configuration gives you fine-grained control over the model, execution environment, and integrations available to the CLI. Use this guide alongside the workflows in codex exec, the guardrails in Sandbox & approvals, and project guidance from AGENTS.md discovery.
Quick navigation

    Feature flags
    Model selection
    Execution environment
    MCP integration
    Observability and telemetry
    Profiles and overrides
    Reference table

Codex supports several mechanisms for setting config values:

    Config-specific command-line flags, such as --model o3 (highest precedence).
    A generic -c/--config flag that takes a key=value pair, such as --config model="o3".
        The key can contain dots to set a value deeper than the root, e.g. --config model_providers.openai.wire_api="chat".
        For consistency with config.toml, values are a string in TOML format rather than JSON format, so use key='{a = 1, b = 2}' rather than key='{"a": 1, "b": 2}'.
            The quotes around the value are necessary, as without them your shell would split the config argument on spaces, resulting in codex receiving -c key={a with (invalid) additional arguments =, 1,, b, =, 2}.
        Values can contain any TOML object, such as --config shell_environment_policy.include_only='["PATH", "HOME", "USER"]'.
        If value cannot be parsed as a valid TOML value, it is treated as a string value. This means that -c model='"o3"' and -c model=o3 are equivalent.
            In the first case, the value is the TOML string "o3", while in the second the value is o3, which is not valid TOML and therefore treated as the TOML string "o3".
            Because quotes are interpreted by one's shell, -c key="true" will be correctly interpreted in TOML as key = true (a boolean) and not key = "true" (a string). If for some reason you needed the string "true", you would need to use -c key='"true"' (note the two sets of quotes).
    The $CODEX_HOME/config.toml configuration file where the CODEX_HOME environment value defaults to ~/.codex. (Note CODEX_HOME will also be where logs and other Codex-related information are stored.)

Both the --config flag and the config.toml file support the following options:

Observability and telemetry
otel

Codex can emit OpenTelemetry log events that describe each run: outbound API requests, streamed responses, user input, tool-approval decisions, and the result of every tool invocation. Export is disabled by default so local runs remain self-contained. Opt in by adding an [otel] table and choosing an exporter.

[otel]
environment = "staging" # defaults to "dev"
exporter = "none" # defaults to "none"; set to otlp-http or otlp-grpc to send events
log_user_prompt = false # defaults to false; redact prompt text unless explicitly enabled

Codex tags every exported event with service.name = $ORIGINATOR (the same value sent in the originator header, codex_cli_rs by default), the CLI version, and an env attribute so downstream collectors can distinguish dev/staging/prod traffic. Only telemetry produced inside the codex_otel crate—the events listed below—is forwarded to the exporter.
Event catalog

Every event shares a common set of metadata fields: event.timestamp, conversation.id, app.version, auth_mode (when available), user.account_id (when available), user.email (when available), terminal.type, model, and slug.

With OTEL enabled Codex emits the following event types (in addition to the metadata above):

    codex.conversation_starts
        provider_name
        reasoning_effort (optional)
        reasoning_summary
        context_window (optional)
        max_output_tokens (optional)
        auto_compact_token_limit (optional)
        approval_policy
        sandbox_policy
        mcp_servers (comma-separated list)
        active_profile (optional)
    codex.api_request
        attempt
        duration_ms
        http.response.status_code (optional)
        error.message (failures)
    codex.sse_event
        event.kind
        duration_ms
        error.message (failures)
        input_token_count (responses only)
        output_token_count (responses only)
        cached_token_count (responses only, optional)
        reasoning_token_count (responses only, optional)
        tool_token_count (responses only)
    codex.user_prompt
        prompt_length
        prompt (redacted unless log_user_prompt = true)
    codex.tool_decision
        tool_name
        call_id
        decision (approved, approved_execpolicy_amendment, approved_for_session, denied, or abort)
        source (config or user)
    codex.tool_result
        tool_name
        call_id (optional)
        arguments (optional)
        duration_ms (execution time for the tool)
        success ("true" or "false")
        output

These event shapes may change as we iterate.
Choosing an exporter

Set otel.exporter to control where events go:

    none – leaves instrumentation active but skips exporting. This is the default.

    otlp-http – posts OTLP log records to an OTLP/HTTP collector. Specify the endpoint, protocol, and headers your collector expects:

    [otel.exporter."otlp-http"]
    endpoint = "https://otel.example.com/v1/logs"
    protocol = "binary"

    [otel.exporter."otlp-http".headers]
    "x-otlp-api-key" = "${OTLP_TOKEN}"

otlp-grpc – streams OTLP log records over gRPC. Provide the endpoint and any metadata headers:

[otel]
exporter = { otlp-grpc = {endpoint = "https://otel.example.com:4317",headers = { "x-otlp-meta" = "abc123" }}}

Both OTLP exporters accept an optional tls block so you can trust a custom CA or enable mutual TLS. Relative paths are resolved against ~/.codex/:

[otel.exporter."otlp-http"]
endpoint = "https://otel.example.com/v1/logs"
protocol = "binary"

[otel.exporter."otlp-http".headers]
"x-otlp-api-key" = "${OTLP_TOKEN}"

[otel.exporter."otlp-http".tls]
ca-certificate = "certs/otel-ca.pem"
client-certificate = "/etc/codex/certs/client.pem"
client-private-key = "/etc/codex/certs/client-key.pem"

If the exporter is none nothing is written anywhere; otherwise you must run or point to your own collector. All exporters run on a background batch worker that is flushed on shutdown.

If you build Codex from source the OTEL crate is still behind an otel feature flag; the official prebuilt binaries ship with the feature enabled. When the feature is disabled the telemetry hooks become no-ops so the CLI continues to function without the extra dependencies.
notify

Specify a program that will be executed to get notified about events generated by Codex. Note that the program will receive the notification argument as a string of JSON, e.g.:

{
"type": "agent-turn-complete",
"thread-id": "b5f6c1c2-1111-2222-3333-444455556666",
"turn-id": "12345",
"cwd": "/Users/alice/projects/example",
"input-messages": ["Rename `foo` to `bar` and update the callsites."],
"last-assistant-message": "Rename complete and verified `cargo build` succeeds."
}

The "type" property will always be set. Currently, "agent-turn-complete" is the only notification type that is supported.

"thread-id" contains a string that identifies the Codex session that produced the notification; you can use it to correlate multiple turns that belong to the same task.

"cwd" reports the absolute working directory for the session so scripts can disambiguate which project triggered the notification.

As an example, here is a Python script that parses the JSON and decides whether to show a desktop push notification using terminal-notifier on macOS:

#!/usr/bin/env python3

import json
import subprocess
import sys

def main() -> int:
if len(sys.argv) != 2:
print("Usage: notify.py <NOTIFICATION_JSON>")
return 1

    try:
        notification = json.loads(sys.argv[1])
    except json.JSONDecodeError:
        return 1

    match notification_type := notification.get("type"):
        case "agent-turn-complete":
            assistant_message = notification.get("last-assistant-message")
            if assistant_message:
                title = f"Codex: {assistant_message}"
            else:
                title = "Codex: Turn Complete!"
            input_messages = notification.get("input-messages", [])
            message = " ".join(input_messages)
            title += message
        case _:
            print(f"not sending a push notification for: {notification_type}")
            return 0

    thread_id = notification.get("thread-id", "")

    subprocess.check_output(
        [
            "terminal-notifier",
            "-title",
            title,
            "-message",
            message,
            "-group",
            "codex-" + thread_id,
            "-ignoreDnD",
            "-activate",
            "com.googlecode.iterm2",
        ]
    )

    return 0

if **name** == "**main**":
sys.exit(main())

To have Codex use this script for notifications, you would configure it via notify in ~/.codex/config.toml using the appropriate path to notify.py on your computer:

notify = ["python3", "/Users/mbolin/.codex/notify.py"]

Note

Use notify for automation and integrations: Codex invokes your external program with a single JSON argument for each event, independent of the TUI. If you only want lightweight desktop notifications while using the TUI, prefer tui.notifications, which uses terminal escape codes and requires no external program. You can enable both; tui.notifications covers in‑TUI alerts (e.g., approval prompts), while notify is best for system‑level hooks or custom notifiers. Currently, notify emits only agent-turn-complete, whereas tui.notifications supports agent-turn-complete and approval-requested with optional filtering.

When Codex detects WSL 2 inside Windows Terminal (the session exports WT_SESSION), tui.notifications automatically switches to a Windows toast backend by spawning powershell.exe. This ensures both approval prompts and completed turns trigger native toasts even though Windows Terminal ignores OSC 9 escape sequences. Terminals that advertise OSC 9 support (iTerm2, WezTerm, kitty, etc.) continue to use the existing escape-sequence backend, and the notify hook remains unchanged.
