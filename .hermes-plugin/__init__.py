"""Blind spots for Hermes Agent: registers the one skill with Hermes' loader."""

import re
from pathlib import Path

NAME = "blind-spots"


def _skill_file() -> Path:
    # A git-clone install keeps skills/ beside .hermes-plugin/; a flattened
    # install puts it next to this file.
    here = Path(__file__).resolve().parent
    for root in (here.parent, here):
        candidate = root / "skills" / NAME / "SKILL.md"
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        "blind-spots plugin: cannot find skills/blind-spots/SKILL.md. "
        "Reinstall with `hermes plugins install aadityasp/blind-spots --enable`."
    )


def _description(text: str) -> str:
    match = re.match(r"^---\n([\s\S]*?)\n---\n", text)
    if not match:
        return ""
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip() == "description":
            return value.strip().strip("\"'")
    return ""


def register(ctx):
    skill = _skill_file()
    # register_skill needs a pathlib.Path, not a str.
    ctx.register_skill(NAME, skill, description=_description(skill.read_text(encoding="utf-8")))
