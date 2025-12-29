"""Data types for streamlit-d3-network."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Node:
    """A graph node.

    Args:
        id: Unique identifier.
        label: Display label.
        type: Node type key (maps to a NodeType for shape/color).
        zone: Zone name this node belongs to (for clustering).
        tooltip: Extra tooltip lines (list of strings).
        color: Override fill color (hex). If None, uses NodeType color.
        border_color: Override border color (hex).
        radius: Node radius in pixels.
        status: Status badge — named color (ok/warn/error/info/off) or hex.
        image: URL of an image/avatar to display inside the node.
        data: Arbitrary extra data accessible in JS and shown in info panel.
    """

    id: str
    label: str
    type: str = "default"
    zone: str = ""
    tooltip: list[str] = field(default_factory=list)
    color: str | None = None
    border_color: str | None = None
    radius: int = 20
    status: str = ""
    image: str = ""
    opacity: float = 1.0
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        # Remove None values to keep JSON clean
        return {k: v for k, v in d.items() if v is not None}


@dataclass
class Link:
    """A graph edge.

    Args:
        source: Source node ID.
        target: Target node ID.
        label: Edge label (displayed on the link).
        color: Edge color (hex).
        width: Stroke width.
        dashed: If True, render as dashed line.
        data: Arbitrary extra data.
    """

    source: str
    target: str
    label: str = ""
    color: str = "#adb5bd"
    width: float = 1.5
    dashed: bool = False
    directed: bool = True
    opacity: float = 1.0
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Zone:
    """A zone for clustering nodes.

    Args:
        name: Unique zone key (matches Node.zone).
        label: Display label.
        color: Zone background/hull color (hex).
    """

    name: str
    label: str
    color: str = "#e9ecef"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class NodeType:
    """Visual style for a node type.

    Args:
        shape: One of "circle", "rect", "diamond", "hexagon", "triangle",
               "triangle-down", "star", or a custom SVG path string.
        color: Default fill color (hex).
        border_color: Default border color (hex).
        icon: Optional emoji/text rendered inside the node.
        label: Human-readable type name (for legend).
    """

    shape: str = "circle"
    color: str = "#e9ecef"
    border_color: str | None = None
    icon: str = ""
    label: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        return {k: v for k, v in d.items() if v is not None and v != ""}


@dataclass
class Action:
    """An action button shown in the node info panel.

    Args:
        key: Unique action key (returned in result.action).
        label: Button label text.
        icon: Optional emoji/icon prefix.
    """

    key: str
    label: str
    icon: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class GraphConfig:
    """Full graph configuration passed to the component.

    This is the internal data structure serialized to JSON for the frontend.
    Users don't interact with this directly — it's built by the component wrapper.
    """

    nodes: list[dict] = field(default_factory=list)
    links: list[dict] = field(default_factory=list)
    zones: list[dict] = field(default_factory=list)
    node_types: dict[str, dict] = field(default_factory=dict)
    actions: dict[str, list[dict]] = field(default_factory=dict)
    options: dict[str, Any] = field(default_factory=dict)
    # Agent commands (Python → JS)
    highlight: list[str] = field(default_factory=list)
    zoom_to: str = ""
    filter_type: str = ""
    filter_value: str = ""

    def to_dict(self) -> dict:
        return asdict(self)
