import streamlit as st
from streamlit_d3_network import Action, Link, Node, NodeType, Zone, st_d3_network

zones = [
    Zone(name="backend", label="Backend", color="#b2f2bb"),
    Zone(name="data", label="Data Layer", color="#ffec99"),
]

node_types = {
    "service": NodeType(shape="circle", color="#b2f2bb", border_color="#2f9e44", label="Service"),
    "database": NodeType(shape="hexagon", color="#ffd43b", border_color="#f08c00", label="Database"),
}

nodes = [
    Node(id="api", label="API Gateway", type="service", zone="backend",
         status="ok", tooltip=["Version: 3.2", "CPU: 45%"]),
    Node(id="auth", label="Auth Service", type="service", zone="backend",
         status="warn", tooltip=["OAuth 2.0"]),
    Node(id="pg", label="PostgreSQL", type="database", zone="data",
         status="ok", data={"version": "16.2", "size": "245 GB"}),
]

links = [
    Link(source="api", target="auth", label="JWT", color="#339af0"),
    Link(source="api", target="pg", label="r/w", color="#f08c00", width=2),
    Link(source="auth", target="pg", label="r/w", color="#f08c00"),
]

actions = {
    "service": [Action(key="logs", label="View Logs"), Action(key="metrics", label="Metrics")],
    "*": [Action(key="details", label="Details")],
}

result = st_d3_network(
    nodes=nodes,
    links=links,
    zones=zones,
    node_types=node_types,
    actions=actions,
    show_hulls=True,
    show_particles=True,
    height=600,
    key="my_graph",
)

if result and result.get("action"):
    st.success(f"Action: {result['action']['key']} on {result['action']['node_label']}")