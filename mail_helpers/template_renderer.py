"""Jinja rendering for the HTML email bodies in mail_helpers/templates."""
from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

TEMPLATES_DIR = Path(__file__).parent / "templates"

_env = Environment(
    loader=FileSystemLoader(TEMPLATES_DIR),
    autoescape=select_autoescape(["html"]),
)


def render_template(template_name: str, **context) -> str:
    """Render an email template to an HTML string.

    Args:
        template_name: File name inside mail_helpers/templates.
        **context: Variables passed to the template.

    Returns:
        Rendered HTML.
    """
    return _env.get_template(template_name).render(**context)
