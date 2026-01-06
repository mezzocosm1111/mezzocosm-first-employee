# SOP: Deploying Mezzo on n8n (Render)

**Goal:** Create a production-ready workflow where Mezzo responds to incoming messages via n8n.

## Required Inputs
*   n8n instance (Self-hosted on Render or Cloud)
*   OpenAI API Key
*   Messaging Service Credentials (Twilio, Slack, or Email)
*   Mezzo Source Files (`README.md`, `sops/knowledge_base.md`)

## Architecture
`Webhook (In)` -> `Mezzo (LLM Chain)` -> `Webhook (Out)`

---

## Steps

### 1. The Brain (LLM Chain)
We need to construct the "System Prompt" dynamically inside n8n.

1.  **Read Files Node**
    *   **Action:** Use a "Read Binary File" or "Execute Command" node to read `README.md` and `sops/knowledge_base.md`.
    *   **Reason:** This keeps your n8n workflow in sync with your source of truth repository. Do not hardcode the prompt in the node if possible.
    *   *Alternative:* If reading files is hard on your hosted instance, paste the content of `README.md` + `knowledge_base.md` into a "Set" node variable called `system_prompt`.

2.  **LLM Node (OpenAI / LangChain)**
    *   **Model:** GPT-4o or GPT-4-Turbo (Recommended for reasoning).
    *   **Temperature:** `0.2` (Strict/Deterministic).
    *   **System Message:**
        ```text
        {{ $node["Read Files"].json["readme_content"] }}
        
        # KNOWLEDGE BASE
        {{ $node["Read Files"].json["knowledge_base_content"] }}
        ```

3.  **Memory (Window Buffer)**
    *   Attach a "Window Buffer Memory" to the LLM Chain to allow for conversation history (e.g., last 10 messages).

### 2. The Body (Inputs & Outputs)

#### For SMS (Twilio)
1.  **Webhook Node (POST)**
    *   Path: `/webhook/sms`
    *   Authentication: None (Validate signature inside if needed) or Basic Auth.
2.  **Mezzo Chain**
    *   Input: `{{ $json.body.Body }}` (The text message).
3.  **Twilio Node**
    *   Action: Send SMS.
    *   To: `{{ $json.body.From }}`
    *   Message: `{{ $node["Mezzo Chain"].json["output"] }}`

#### For Testing (Webhook)
1.  **Webhook Node (GET/POST)**
    *   Path: `/chat`
    *   Query Param: `message`
2.  **Mezzo Chain**
3.  **Respond to Webhook Node**
    *   Respond with: `{{ $node["Mezzo Chain"].json["output"] }}`

---

## Edge Cases

*   **Case:** **"I need to speak to a human"**
    *   **Mezzo Logic:** The System Prompt (README) instructs Mezzo to stop.
    *   **n8n Logic:** You can add an "If" node after the LLM.
    *   **Condition:** If output contains "HANDOFF" (you'd need to add this instruction to the README), route to a Slack/Email alert node instead of replying.

*   **Case:** **Error / Timeout**
    *   **Resolution:** Use n8n "Error Trigger" workflow to alert you if the bot goes down.
