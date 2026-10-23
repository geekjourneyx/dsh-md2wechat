# Conversation article entry — 2026-10-24

User reported full-width composer dock on wide screens and requested an icon disclosure. Replaced the permanent article card with a labeled icon button, inline disclosure, selected article title/select and one Open Article action. Uses the host composer maximum width token instead of viewport width. Escape returns focus to the icon; opening an article and switching conversations collapse the disclosure. Long titles truncate with a full title tooltip; touch targets expand for coarse pointers. Existing source-conversation ownership remains unchanged.

Also corrected suggestion headings: title, polish and layout requests now display their respective Chinese labels.

Validation: typecheck/build and lint passed. Initial full suite had 830 passes and one outdated always-visible-card assertion; updated it to exercise disclosure before opening, and all 19 affected tests passed. Installed package in local DSH. Actual browser checks at 2048×1152 and 390×844: no dock overflow, correct width constraint, Escape collapse, opening exact current article, disclosure collapses after opening. Viewport override reset after testing. No article edits, model calls, paid generation or WeChat writes were performed.
