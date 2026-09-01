from typing import Optional
from pydantic import BaseModel, Field


class TaggedArticleUpdate(BaseModel):
    """A partial update for one tagged article.

    The AI-tagged fields plus the `title`, `content`, `url` and `date` metadata are
    accepted; the remaining body fields (reach, …) cannot be edited here and unknown
    fields are ignored. Every field except `id` is optional, so callers send only
    what changed. `id` is the primary key (e.g. "A1"). An edited `date` is
    normalized to canonical ISO server-side; editing `url` recomputes the domain.
    Editing `title` or `content` re-runs the tagger and the keyword match over the
    new text — a paywalled article whose body the user finally pasted in was tagged
    from its title alone, so its tags are stale until it is re-tagged.
    """
    id: str
    title: Optional[str] = None
    # The article body. A paywalled article stores the sentinel "Subscription" here
    # until a user types the real text in from the review table.
    content: Optional[str] = None
    url: Optional[str] = None
    date: Optional[str] = None
    # Human-readable publication name (derived from the domain, but editable).
    domain_name: Optional[str] = None
    # Query keywords found in the article's title/content (editable).
    keyword_matched: Optional[list[str]] = None
    sentiment: Optional[str] = None
    theme: Optional[str] = None
    summary: Optional[str] = None
    sentiment_confidence: Optional[float] = Field(default=None, ge=0, le=100)  # 0–100 percent; stored as a 0–1 float
    theme_confidence: Optional[float] = Field(default=None, ge=0, le=100)
    section_category_confidence: Optional[float] = Field(default=None, ge=0, le=100)
    relevancy_confidence: Optional[float] = Field(default=None, ge=0, le=100)
    relevancy_reason: Optional[str] = None
    xai_theme_reason: Optional[str] = None
    xai_sentiment_reason: Optional[str] = None
    priority_watch: Optional[bool] = None
    section: Optional[str] = None
    section_reason: Optional[str] = None
    syndication_of: Optional[str] = None
    similar_group_id: Optional[str] = None
    brand_of_interest: Optional[list[str]] = None
    competitors: Optional[list[str]] = None
    other_competitors: Optional[list[str]] = None
    peoples: Optional[list[str]] = None
    countries: Optional[list[str]] = None
    organizations: Optional[list[str]] = None



class NewTaggedArticle(BaseModel):
    """A manually-added article for the review table — body fields plus tags.
    A fresh `A{n}` id is assigned server-side. Either title or content is required."""
    title: str
    content: str
    date: str
    url: str
    reach: Optional[int] = None
    sentiment: Optional[str] = None
    theme: Optional[str] = None
    summary: Optional[str] = None
    sentiment_confidence: Optional[float] = Field(default=None, ge=0, le=100)
    theme_confidence: Optional[float] = Field(default=None, ge=0, le=100)
    section_category_confidence: Optional[float] = Field(default=None, ge=0, le=100)
    relevancy_confidence: Optional[float] = Field(default=None, ge=0, le=100)
    relevancy_reason: Optional[str] = None
    xai_theme_reason: Optional[str] = None
    xai_sentiment_reason: Optional[str] = None
    priority_watch: Optional[bool] = None
    section: Optional[str] = None
    section_reason: Optional[str] = None
    brand_of_interest: Optional[list[str]] = Field(default=None, min_length=1, max_length=1)
    competitors: Optional[list[str]] = None
    other_competitors: Optional[list[str]] = None
    peoples: Optional[list[str]] = None
    countries: Optional[list[str]] = None
    organizations: Optional[list[str]] = None


class ApproveRequest(BaseModel):
    """Mark a set of articles approved (or not) by id.

    `for_monitoring` selects which approval to set: the Media Monitoring review popup
    approves into `is_approved_for_monitoring`, every other review into `is_approved`.
    Approving for monitoring also approves for the dashboards — the monitoring review is
    the stricter one. Nothing cascades the other way: withdrawing a monitoring approval
    leaves the dashboards one, which can also be granted on its own."""
    ids: list[str]
    is_approved: bool = True
    for_monitoring: bool = False


class MarkRelevantRequest(BaseModel):
    """Promote one or more irrelevant articles to relevant (and AI-tag them) by id."""
    ids: list[str]


class MarkIrrelevantRequest(BaseModel):
    """Demote one or more relevant articles to irrelevant by id.

    Keeps the existing tags — only flips ``is_relevant`` to False and records the
    ``reason`` (required) as the not-relevant reason."""
    ids: list[str]
    reason: str = Field(..., min_length=1)


class ExportArticlesRequest(BaseModel):
    """What the review screen's Excel download should contain.

    `types` picks the relevance buckets to include — any of "relevant" /
    "irrelevant". `fields` are keys from the export catalogue
    (`GET /tagging/export/fields`); an empty list means its default columns."""
    types: list[str] = Field(default_factory=lambda: ["relevant", "irrelevant"])
    fields: list[str] = Field(default_factory=list)


class FetchArticleRequest(BaseModel):
    """Fetch a single article by URL and AI-tag it (preview, not yet saved)."""
    url: str


class TagManualRequest(BaseModel):
    """AI-tag a manually-entered article (preview, not yet saved).

    Used when a URL can't be fetched (e.g. paywalled): the user types the body
    fields in and we tag those directly, skipping the content fetch."""
    title: Optional[str] = ""
    content: Optional[str] = ""
    date: Optional[str] = ""
    url: Optional[str] = ""
    author: Optional[str] = ""
