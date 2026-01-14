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
    layout: str = "force",
    theme: dict[str, str] | None = None,
    height: int = 600,
    key: str | None = None,
) -> dict[str, Any] | None:
    """Render an interactive D3.js force-directed network graph."""
    from .component import render

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
            "showSearch": show_search,
            "showExport": show_export,
            "showParticles": show_particles,
            "layout": layout,
            "theme": theme or {},
        },
        highlight=highlight or [],
        zoom_to=zoom_to,
        filter_type="zone" if filter_zone else ("type" if filter_type else ""),
        filter_value=filter_zone or filter_type or "",
    )

    return render(config.to_dict(), height=height, key=key)
