"""Streamlit v2 component registration and wrapper."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import streamlit.components.v2 as components

_FRONTEND_DIR = Path(__file__).parent / "frontend"
_CSS_TEXT = (_FRONTEND_DIR / "graph.css").read_text()

_component = components.component(
    "streamlit_d3_network",
    js=(_FRONTEND_DIR / "graph.js").read_text(),
    html='<div style="width:100%;height:100%"></div>',
)


def render(
    graph_data: dict[str, Any],
    *,
    height: int = 600,
    key: str | None = None,
) -> dict[str, Any] | None:
    """Render the D3 network graph component.

    Args:
        graph_data: Full graph config dict (nodes, links, zones, node_types, etc.).
        height: Component height in pixels.
        key: Unique key for this component instance.

    Returns:
        A dict with component state:
          - selected_node: {id, label, type, zone, status, data, connected} or None.
          - action: Action triggered from info panel (fire-once) or None.
          - node_positions: Persisted node positions {id: {x, y, pinned}}.
          - zoom_transform: Persisted zoom state {k, x, y}.
    """
    import streamlit as st

    # Round-trip persisted state: read from session_state, inject into data for JS
    state_key = f"_sd3n_state_{key}" if key else None
    saved_state = {}
    if state_key and state_key in st.session_state:
        saved_state = st.session_state[state_key]

    # Inject state, height, and CSS into data for JS to use
    graph_data_with_state = {
        **graph_data,
        "_state": saved_state,
        "_height": height,
        "_css": _CSS_TEXT,
    }

    result = _component(
        data=graph_data_with_state,
        default={
            "selected_node": None,
            "node_positions": {},
            "zoom_transform": None,
        },
        height=height,
        key=key,
        on_selected_node_change=lambda: None,
        on_action_change=lambda: None,
        on_node_positions_change=lambda: None,
        on_zoom_transform_change=lambda: None,
    )

    if result is None:
        return None

    out = {
        "selected_node": getattr(result, "selected_node", None),
        "action": getattr(result, "action", None),
        "node_positions": getattr(result, "node_positions", {}),
        "zoom_transform": getattr(result, "zoom_transform", None),
    }

    # Persist state for next rerun
    if state_key:
        st.session_state[state_key] = {
            "node_positions": out["node_positions"],
            "zoom_transform": out["zoom_transform"],
            "selected_node": out["selected_node"],
        }

    return out
