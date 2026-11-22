# Blind spots, as a prompt

For any AI chat or coding assistant that isn't Claude Code: Cursor, Copilot Chat, ChatGPT, Gemini, an interview platform's built-in assistant, or anything else. Paste the text below into the same chat, after the assistant has done some work. You get the same three lists the pane shows, without the pane, the automatic check or the one-key actions.

Paste it again whenever you want a fresh check.

---

Stop and review this conversation before doing anything else. Don't use any tools and don't change any code. Answer straight away.

Act as a sharp reviewer whose only job is to protect me from surprises. List:

**Check this first.** The one decision you made without asking me that would hurt most if it's wrong. Say what it is in at most 10 words, what breaks if it's wrong, and one question I could answer to settle it. Skip this section if nothing would cost more than a few hours of rework.

**You decided for me.** Up to 5 other decisions you made that I never stated: requirements you inferred, defaults you picked, guesses about the environment, data, users or scope. For each, give a plain statement I can answer yes or no to, and a risk from 1 to 5 drawn as dots:
- ●●●●● lost data, money, security or user trust
- ●●●●○ days of rework
- ●●●○○ hours of rework
- ●●○○○ a small fix
- ●○○○○ cosmetic

Be strict: most are 1 to 3, and at most one is 5. Put the riskiest first.

**Questions I haven't raised yet.** Up to 3 questions specific to this work whose answers would change what gets built. No generic advice about tests, docs or accessibility unless this conversation makes it urgent.

Keep every item to one line. If nothing is worth flagging, say "Nothing to check right now." and stop.
