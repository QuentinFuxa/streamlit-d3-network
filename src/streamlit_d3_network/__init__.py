"""streamlit-d3-network — Interactive D3.js network graph for Streamlit.

Usage::

    from streamlit_d3_network import st_d3_network, Node, Link, Zone, NodeType, Action

    result = st_d3_network(
        nodes=[Node(id="a", label="Node A"), Node(id="b", label="Node B")],
        links=[Link(source="a", target="b")],
    )
"""

from __future__ import annotations

from typing import Any

from .types import Action, GraphConfig, Link, Node, NodeType, Zone

__all__ = [
    "st_d3_network",
    "Node",
    "Link",
    "Zone",
    "NodeType",
    "Action",
    "GraphConfig",
]


def st_d3_network(
    nodes: list[Node],
    links: list[Link],
    *,
    zones: list[Zone] | None = None,
    node_types: dict[str, NodeType] | None = None,
    actions: dict[str, list[Action]] | None = None,
    highlight: list[str] | None = None,
    zoom_to: str = "",
    filter_zone: str = "",
    filter_type: str = "",
    show_labels: bool = True,
    show_hulls: bool = True,
    show_legend: bool = True,
    show_search: bool = True,
    show_export: bool = False,
    show_particles: bool = True,
    show_toolbar: bool = True,
    show_stats: bool = True,
    show_minimap: bool = True,
    layout: str = "force",
    theme: dict[str, str] | None = None,
    compact: bool = False,
    lang: str = "",
    height: int = 600,
    key: str | None = None,
) -> dict[str, Any] | None:
    """Render an interactive D3.js force-directed network graph.

    Args:
        nodes: List of Node objects.
        links: List of Link objects (edges).
        zones: Optional list of Zone objects for clustering.
        node_types: Dict mapping type key → NodeType (shape, color, icon).
        actions: Dict mapping node type → list of Action buttons.
            Use "*" as key for actions on all node types.
        highlight: List of node IDs to highlight (Python → JS).
        zoom_to: Node ID to zoom to (Python → JS).
        filter_zone: Zone name to highlight (Python → JS).
        filter_type: Node type to highlight (Python → JS).
        show_labels: Show edge labels.
        show_hulls: Show convex hull backgrounds per zone.
        show_legend: Show the legend panel.
        show_search: Show the search box.
        show_export: Show PNG/SVG export buttons.
        show_particles: Show animated flow particles along edges.
        layout: Initial layout mode — "force", "radial", "hierarchical", "grid".
        theme: Optional CSS variable overrides, e.g. {"accent": "#ff0000"}.
        height: Component height in pixels.
        key: Unique Streamlit key for this instance.

    Returns:
        A dict with:
          - selected_node: {id, label, type, zone} or None.
          - action: {key, node_id, node_label, node_type, ...} or None (fire-once).
          - node_positions: {id: {x, y, pinned}} — persisted layout.
          - zoom_transform: {k, x, y} — persisted zoom.
        Returns None before first render.
    """
    from .component import render

    # Build graph config
    config = GraphConfig(
        nodes=[n.to_dict() for n in nodes],
        links=[l.to_dict() for l in links],
        zones=[z.to_dict() for z in (zones or [])],
        node_types={k: v.to_dict() for k, v in (node_types or {}).items()},
        actions={k: [a.to_dict() for a in v] for k, v in (actions or {}).items()},
        options={
            "showLabels": show_labels,
            "showHulls": show_hulls,
            "showLegend": show_legend,
            "legendCollapsed": compact,
            "showSearch": show_search if not compact else False,
            "showExport": show_export if not compact else False,
            "showParticles": show_particles,
            "showToolbar": show_toolbar if not compact else False,
            "showStats": show_stats if not compact else False,
            "showMinimap": show_minimap if not compact else False,
            "layout": layout,
            "theme": theme or {},
            "lang": lang or ("fr" if compact else ""),
        },
        highlight=highlight or [],
        zoom_to=zoom_to,
        filter_type="zone" if filter_zone else ("type" if filter_type else ""),
        filter_value=filter_zone or filter_type or "",
    )

    return render(config.to_dict(), height=height, key=key)
