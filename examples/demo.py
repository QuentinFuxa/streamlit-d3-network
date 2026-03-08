"""
EDAtt: Attention as a Guide for Simultaneous Speech Translation
================================================================
Interactive visualization of the EDAtt/AlignAtt policy (Papi et al., ACL 2023)
using streamlit-d3-network.

Run with:
    cd packages/streamlit-d3-network
    pip install -e .
    streamlit run examples/demo.py
"""

import math
import streamlit as st
import numpy as np

st.set_page_config(
    layout="wide",
    page_title="EDAtt - Simultaneous Speech Translation",
    page_icon="https://raw.githubusercontent.com/google/material-design-icons/master/symbols/web/translate/materialsymbolsoutlined/translate_24px.svg",
)

from streamlit_d3_network import Action, Link, Node, NodeType, Zone, st_d3_network

# ---------------------------------------------------------------------------
# Constants & example data from the paper (Figure 1)
# ---------------------------------------------------------------------------

# Source (English audio segmented into frames) and target (German translation)
SOURCE_WORDS = [
    "I'm", "going", "to", "talk", "about", "climate",
]
TARGET_WORDS = [
    "Ich", "werde", "ueber", "Klima", "sprechen",
]

# Simulated cross-attention matrix (6 source frames x 5 target tokens)
# This mimics the pseudo-diagonal alignment pattern described in the paper
# after removing the attention sink (last frame).
RAW_ATTENTION = np.array([
    # Ich    werde  ueber  Klima  sprechen
    [0.01,  0.01,  0.00,  0.00,  0.00],   # I'm
    [0.01,  0.01,  0.01,  0.00,  0.00],   # going
    [0.00,  0.01,  0.01,  0.00,  0.00],   # to
    [0.00,  0.00,  0.02,  0.01,  0.00],   # talk
    [0.00,  0.00,  0.01,  0.02,  0.01],   # about
    [0.00,  0.00,  0.00,  0.01,  0.02],   # climate
], dtype=np.float64)

# The attention sink: last encoder frame absorbs ~97% of attention
SINK_WEIGHT = 0.97


def make_attention_with_sink(raw: np.ndarray, sink_pct: float = SINK_WEIGHT) -> np.ndarray:
    """Create raw attention where the last frame absorbs most weight."""
    n_src, n_tgt = raw.shape
    result = np.zeros((n_src + 1, n_tgt))
    # Fill real attention (scaled down)
    real_scale = 1.0 - sink_pct
    for j in range(n_tgt):
        col_sum = raw[:, j].sum()
        if col_sum > 0:
            result[:n_src, j] = raw[:, j] / col_sum * real_scale
        # Last row = sink
        result[n_src, j] = sink_pct
    return result


ATTENTION_WITH_SINK = make_attention_with_sink(RAW_ATTENTION)

# Normalize filtered attention per column
FILTERED_ATTENTION = RAW_ATTENTION.copy()
for j in range(FILTERED_ATTENTION.shape[1]):
    col_sum = FILTERED_ATTENTION[:, j].sum()
    if col_sum > 0:
        FILTERED_ATTENTION[:, j] /= col_sum


# ---------------------------------------------------------------------------
# Color palettes
# ---------------------------------------------------------------------------

COLORS = {
    "encoder": "#339af0",
    "encoder_bg": "#a5d8ff",
    "decoder": "#f06595",
    "decoder_bg": "#fcc2d7",
    "attention": "#ffd43b",
    "attention_bg": "#fff3bf",
    "read": "#51cf66",
    "write": "#cc5de8",
    "wait": "#ff922b",
    "sink": "#e03131",
    "ok": "#2f9e44",
    "neutral": "#868e96",
    "lambda_zone": "#ffe066",
    "policy": "#845ef7",
    "policy_bg": "#e5dbff",
    "dark_bg": "#212529",
    "time_bg": "#f1f3f5",
}


# ===================================================================
# HEADER
# ===================================================================

st.markdown("""
# EDAtt: Attention as a Guide for Simultaneous Speech Translation

**Paper**: *Attention as a Guide for Simultaneous Speech Translation* --- Papi et al., ACL 2023

**Core idea**: Use encoder-decoder cross-attention weights to decide when to **READ** more audio
input vs. **WRITE** (emit) a translation token, enabling simultaneous speech translation
without any dedicated wait/write classifier.

---
""")

# ===================================================================
# TAB LAYOUT
# ===================================================================

tab1, tab2, tab3, tab4 = st.tabs([
    "1 -- Transformer Architecture",
    "2 -- Attention Matrix Network",
    "3 -- Simultaneous Translation Timeline",
    "4 -- The Attention Sink Discovery",
])


# ===================================================================
# TAB 1: TRANSFORMER ARCHITECTURE
# ===================================================================

with tab1:
    st.markdown("""
    ### Encoder-Decoder Architecture with Cross-Attention

    The EDAtt policy operates on a standard Transformer encoder-decoder architecture for
    speech translation. Audio frames flow through the **encoder** (left), producing hidden
    representations. The **decoder** (right) generates translation tokens auto-regressively.
    The **cross-attention** mechanism (center) connects them: each decoder token attends to
    all available encoder frames.

    The key insight is that the cross-attention weights **already encode alignment information**
    between audio and text --- no external alignment model is needed.
    """)

    col_ctrl, col_info = st.columns([1, 3])
    with col_ctrl:
        arch_layer = st.selectbox(
            "Decoder layer (d)",
            options=[1, 2, 3, 4, 5, 6],
            index=3,
            help="Which decoder layer's cross-attention to visualize. Layer 4 (middle) is optimal per the paper.",
            key="arch_layer",
        )
        arch_head = st.selectbox(
            "Attention head (h)",
            options=["Average (all 8)", "Head 1", "Head 2", "Head 3", "Head 4"],
            index=0,
            help="Which attention head. Averaging all 8 heads gives the best results.",
            key="arch_head",
        )

    with col_info:
        layer_quality = {1: "poor", 2: "moderate", 3: "good", 4: "best", 5: "good", 6: "poor"}
        q = layer_quality[arch_layer]
        if q == "best":
            st.success(f"Layer {arch_layer}: **Best alignment quality** --- middle layers capture the clearest audio-text correspondence.")
        elif q == "good":
            st.info(f"Layer {arch_layer}: Good alignment quality --- close to optimal.")
        elif q == "moderate":
            st.warning(f"Layer {arch_layer}: Moderate alignment --- early layers focus more on local acoustic features.")
        else:
            st.error(f"Layer {arch_layer}: Poor alignment --- {'early layers focus on acoustics' if arch_layer < 3 else 'late layers over-specialize on language modeling'}.")

    # Build architecture graph
    arch_nodes = []
    arch_links = []

    # Encoder nodes (audio frames)
    for i, word in enumerate(SOURCE_WORDS):
        arch_nodes.append(Node(
            id=f"enc_{i}", label=f"x{i+1}: {word}", type="encoder",
            zone="encoder", radius=22,
            tooltip=[f"Audio frame {i+1}", f"Content: \"{word}\"", "Encoder hidden state"],
        ))

    # Encoder output representations
    for i in range(len(SOURCE_WORDS)):
        arch_nodes.append(Node(
            id=f"enc_h_{i}", label=f"h{i+1}", type="enc_hidden",
            zone="encoder", radius=16,
            tooltip=[f"Encoder representation {i+1}", f"After {6} encoder layers"],
        ))
        arch_links.append(Link(
            source=f"enc_{i}", target=f"enc_h_{i}",
            color=COLORS["encoder"], width=2, opacity=0.6,
        ))

    # Cross-attention nodes (one per head, simplified)
    arch_nodes.append(Node(
        id="cross_attn", label=f"Cross-Attention\nLayer {arch_layer}", type="attention",
        zone="cross_attention", radius=35,
        tooltip=[
            f"Decoder layer {arch_layer} cross-attention",
            f"Head: {arch_head}",
            "A(X, Y) = softmax(Q_dec * K_enc^T / sqrt(d))",
            "This is where the READ/WRITE policy lives",
        ],
        data={"layer": arch_layer, "head": arch_head},
    ))

    # Policy decision node
    arch_nodes.append(Node(
        id="policy", label="EDAtt Policy", type="policy",
        zone="cross_attention", radius=30,
        tooltip=[
            "Decision: READ or WRITE?",
            "sum(A[t-lambda:t, j]) < alpha ?",
            "If yes: WRITE token",
            "If no: READ more audio",
        ],
        status="ok",
    ))
    arch_links.append(Link(
        source="cross_attn", target="policy",
        color=COLORS["policy"], width=3, label="weights",
    ))

    # Decoder nodes (translation tokens)
    for j, word in enumerate(TARGET_WORDS):
        arch_nodes.append(Node(
            id=f"dec_{j}", label=f"y{j+1}: {word}", type="decoder",
            zone="decoder", radius=22,
            tooltip=[f"Translation token {j+1}", f"German: \"{word}\""],
        ))

    # Decoder self-attention chain (auto-regressive)
    for j in range(len(TARGET_WORDS) - 1):
        arch_links.append(Link(
            source=f"dec_{j}", target=f"dec_{j+1}",
            color=COLORS["decoder"], width=1.5, dashed=True, opacity=0.4,
            label="auto-reg" if j == 0 else "",
        ))

    # Encoder hidden -> Cross attention
    for i in range(len(SOURCE_WORDS)):
        # Vary opacity by layer quality
        base_opacity = {"poor": 0.2, "moderate": 0.4, "good": 0.7, "best": 0.9}[q]
        arch_links.append(Link(
            source=f"enc_h_{i}", target="cross_attn",
            color=COLORS["encoder"], width=1.5, opacity=base_opacity * 0.6,
        ))

    # Cross attention -> Decoder tokens (weighted)
    for j in range(len(TARGET_WORDS)):
        # Use the attention column for this token
        col = FILTERED_ATTENTION[:, j]
        max_w = col.max()
        dominant_src = int(col.argmax())
        arch_links.append(Link(
            source="cross_attn", target=f"dec_{j}",
            color=COLORS["decoder"], width=1 + max_w * 4,
            opacity=0.4 + max_w * 0.6,
            label=f"from x{dominant_src+1}" if max_w > 0.2 else "",
        ))

    arch_zones = [
        Zone(name="encoder", label="Encoder (Audio Frames)", color=COLORS["encoder_bg"]),
        Zone(name="cross_attention", label="Cross-Attention + Policy", color=COLORS["attention_bg"]),
        Zone(name="decoder", label="Decoder (Translation Tokens)", color=COLORS["decoder_bg"]),
    ]

    arch_node_types = {
        "encoder": NodeType(shape="circle", color=COLORS["encoder_bg"], border_color=COLORS["encoder"], label="Audio Frame"),
        "enc_hidden": NodeType(shape="diamond", color="#d0ebff", border_color=COLORS["encoder"], label="Encoder Hidden"),
        "attention": NodeType(shape="hexagon", color=COLORS["attention"], border_color="#f08c00", label="Cross-Attention"),
        "policy": NodeType(shape="star", color=COLORS["policy_bg"], border_color=COLORS["policy"], label="EDAtt Policy"),
        "decoder": NodeType(shape="rect", color=COLORS["decoder_bg"], border_color=COLORS["decoder"], label="Translation Token"),
    }

    st_d3_network(
        nodes=arch_nodes,
        links=arch_links,
        zones=arch_zones,
        node_types=arch_node_types,
        show_labels=True,
        show_hulls=True,
        show_particles=True,
        show_legend=True,
        show_search=False,
        layout="hierarchical",
        height=600,
        key="arch_graph",
    )

    st.caption("Drag nodes to rearrange. The cross-attention mechanism connects every encoder frame to every decoder token --- the EDAtt policy reads these weights to decide when to emit translations.")


# ===================================================================
# TAB 2: ATTENTION MATRIX AS A NETWORK
# ===================================================================

with tab2:
    st.markdown("""
    ### The Attention Matrix as a Bipartite Network

    Instead of a traditional heatmap, we visualize the cross-attention matrix **A(X, Y)** as a
    bipartite network. Audio frames (left) connect to translation tokens (right) with link
    widths proportional to attention weights.

    **The EDAtt decision rule**: For token y_j, sum the attention weights on the last
    **lambda** audio frames. If this sum is **below alpha**, the attention is focused on earlier
    (complete) audio --- safe to **WRITE**. If the sum is **above alpha**, attention is on the
    most recent (potentially incomplete) audio --- **WAIT** for more input.
    """)

    col_alpha, col_lambda, col_step = st.columns(3)
    with col_alpha:
        alpha = st.slider(
            "alpha (threshold)",
            min_value=0.0, max_value=1.0, value=0.40, step=0.05,
            help="Lower alpha = more aggressive (lower latency, risk of lower quality). Higher alpha = more conservative (higher quality, more delay).",
            key="alpha_slider",
        )
    with col_lambda:
        lam = st.slider(
            "lambda (recent frames to check)",
            min_value=1, max_value=4, value=2,
            help="Number of most recent encoder frames to sum attention over. Optimal: lambda=2.",
            key="lambda_slider",
        )
    with col_step:
        time_step = st.slider(
            "Time step t (audio received so far)",
            min_value=2, max_value=len(SOURCE_WORDS), value=len(SOURCE_WORDS),
            help="Simulates how much audio has been received. At step t, only frames 1..t are available.",
            key="time_step_slider",
        )

    # Build the bipartite attention network
    attn_nodes = []
    attn_links = []

    available_frames = time_step
    attn_matrix = FILTERED_ATTENTION[:available_frames, :]

    # Re-normalize columns for available frames
    for j in range(attn_matrix.shape[1]):
        cs = attn_matrix[:, j].sum()
        if cs > 0:
            attn_matrix[:, j] /= cs

    # Source audio frame nodes
    for i in range(available_frames):
        is_in_lambda = i >= (available_frames - lam)
        attn_nodes.append(Node(
            id=f"src_{i}",
            label=f"x{i+1}: {SOURCE_WORDS[i]}",
            type="frame_lambda" if is_in_lambda else "frame",
            zone="lambda_zone" if is_in_lambda else "source_audio",
            radius=24,
            tooltip=[
                f"Audio frame {i+1}: \"{SOURCE_WORDS[i]}\"",
                "In LAMBDA window" if is_in_lambda else "Outside lambda window",
            ],
            status="warn" if is_in_lambda else "",
        ))

    # Target translation token nodes + decision logic
    decisions = []
    for j in range(len(TARGET_WORDS)):
        # Compute the sum of attention on the last lambda frames for this token
        lambda_start = max(0, available_frames - lam)
        lambda_attn_sum = attn_matrix[lambda_start:available_frames, j].sum()
        decision = "WRITE" if lambda_attn_sum < alpha else "WAIT"
        decisions.append((TARGET_WORDS[j], lambda_attn_sum, decision))

        status = "ok" if decision == "WRITE" else "warn"
        attn_nodes.append(Node(
            id=f"tgt_{j}",
            label=f"y{j+1}: {TARGET_WORDS[j]}",
            type="token_write" if decision == "WRITE" else "token_wait",
            zone="target_tokens",
            radius=26,
            tooltip=[
                f"Token: \"{TARGET_WORDS[j]}\"",
                f"Lambda-attention sum: {lambda_attn_sum:.3f}",
                f"Threshold alpha: {alpha:.2f}",
                f"Decision: {decision}",
                f"{lambda_attn_sum:.3f} {'<' if decision == 'WRITE' else '>='} {alpha:.2f}",
            ],
            status=status,
        ))

    # Links: attention weights
    for i in range(available_frames):
        for j in range(len(TARGET_WORDS)):
            w = attn_matrix[i, j]
            if w > 0.01:  # threshold for visibility
                is_lambda_link = i >= (available_frames - lam)
                attn_links.append(Link(
                    source=f"src_{i}", target=f"tgt_{j}",
                    width=1 + w * 8,
                    opacity=0.3 + w * 0.7,
                    color=COLORS["wait"] if is_lambda_link else COLORS["encoder"],
                    label=f"{w:.2f}" if w > 0.15 else "",
                ))

    attn_zones = [
        Zone(name="source_audio", label="Audio Frames (outside lambda)", color="#d0ebff"),
        Zone(name="lambda_zone", label=f"Last lambda={lam} frames (checked by policy)", color="#fff3bf"),
        Zone(name="target_tokens", label="Translation Tokens (WRITE / WAIT decision)", color=COLORS["decoder_bg"]),
    ]

    attn_node_types = {
        "frame": NodeType(shape="circle", color="#74c0fc", border_color=COLORS["encoder"], label="Audio Frame"),
        "frame_lambda": NodeType(shape="circle", color=COLORS["lambda_zone"], border_color="#f08c00", label="Frame (in lambda window)"),
        "token_write": NodeType(shape="rect", color="#b2f2bb", border_color=COLORS["ok"], label="WRITE (emit token)"),
        "token_wait": NodeType(shape="rect", color="#ffe8cc", border_color=COLORS["wait"], label="WAIT (need more audio)"),
    }

    st_d3_network(
        nodes=attn_nodes,
        links=attn_links,
        zones=attn_zones,
        node_types=attn_node_types,
        show_labels=True,
        show_hulls=True,
        show_particles=True,
        show_legend=True,
        show_search=False,
        layout="hierarchical",
        height=550,
        key="attn_bipartite",
    )

    # Decision summary table
    st.markdown("#### Token decisions at current settings")
    dec_cols = st.columns(len(decisions))
    for idx, (word, attn_sum, dec) in enumerate(decisions):
        with dec_cols[idx]:
            if dec == "WRITE":
                st.success(f"**{word}**")
                st.caption(f"sum={attn_sum:.3f} < {alpha}")
            else:
                st.warning(f"**{word}**")
                st.caption(f"sum={attn_sum:.3f} >= {alpha}")

    st.markdown(f"""
    ---
    **Reading the graph**: Orange links come from the **lambda window** (last {lam} frames).
    Blue links come from earlier frames. Green tokens will be emitted (WRITE); orange tokens
    must wait. Try lowering **alpha** to emit more aggressively, or raising it to be more conservative.
    """)


# ===================================================================
# TAB 3: SIMULTANEOUS TRANSLATION TIMELINE
# ===================================================================

with tab3:
    st.markdown("""
    ### Simultaneous Translation Timeline: READ vs WRITE

    In simultaneous translation, the system interleaves **READ** actions (consuming the next
    audio chunk) and **WRITE** actions (emitting a translation token). The EDAtt policy
    determines this schedule dynamically based on attention patterns.

    The graph below shows a timeline of decisions. Each node is a time step where the system
    either reads audio or writes a token. The **alpha** threshold controls the latency-quality
    tradeoff.
    """)

    col_a2, col_info2 = st.columns([1, 2])
    with col_a2:
        tl_alpha = st.slider(
            "alpha (quality-latency tradeoff)",
            min_value=0.1, max_value=0.9, value=0.4, step=0.1,
            key="timeline_alpha",
            help="Low alpha = aggressive writing (low latency). High alpha = conservative (high quality).",
        )
    with col_info2:
        if tl_alpha <= 0.2:
            st.error("Very aggressive: tokens emitted with minimal audio context. Low latency but translation may be inaccurate.")
        elif tl_alpha <= 0.4:
            st.success("Balanced: good tradeoff between latency and quality. This is near the optimal operating point.")
        elif tl_alpha <= 0.6:
            st.info("Conservative: waits for more audio before translating. Higher quality but noticeable delay.")
        else:
            st.warning("Very conservative: approaches offline translation quality but with high latency.")

    # Simulate a READ/WRITE schedule based on alpha
    # Lower alpha -> write sooner (after fewer reads)
    # Higher alpha -> write later (after more reads)
    schedule = []
    src_idx = 0
    tgt_idx = 0
    step = 0

    # Simple simulation: after reading enough frames, try to write
    # The "enough" depends on alpha (higher alpha = need more reads before each write)
    reads_before_write = max(1, int(1 + tl_alpha * 3))

    read_count = 0
    while src_idx < len(SOURCE_WORDS) or tgt_idx < len(TARGET_WORDS):
        if src_idx < len(SOURCE_WORDS) and (read_count < reads_before_write or tgt_idx >= len(TARGET_WORDS)):
            schedule.append(("READ", SOURCE_WORDS[src_idx], src_idx))
            src_idx += 1
            read_count += 1
            step += 1
        elif tgt_idx < len(TARGET_WORDS):
            schedule.append(("WRITE", TARGET_WORDS[tgt_idx], tgt_idx))
            tgt_idx += 1
            read_count = 0
            step += 1
        else:
            break

    # Ensure all remaining writes happen
    while tgt_idx < len(TARGET_WORDS):
        schedule.append(("WRITE", TARGET_WORDS[tgt_idx], tgt_idx))
        tgt_idx += 1

    # Build timeline graph
    tl_nodes = []
    tl_links = []

    # Start node
    tl_nodes.append(Node(
        id="start", label="START", type="start",
        zone="timeline", radius=20,
        tooltip=["Translation begins", "Waiting for first audio frame"],
    ))

    for i, (action, word, orig_idx) in enumerate(schedule):
        node_id = f"step_{i}"
        if action == "READ":
            tl_nodes.append(Node(
                id=node_id,
                label=f"READ\n\"{word}\"",
                type="read",
                zone="timeline",
                radius=22,
                tooltip=[
                    f"Step {i+1}: READ",
                    f"Receive audio frame: \"{word}\"",
                    f"Source frame index: {orig_idx+1}",
                ],
                status="info",
            ))
        else:
            tl_nodes.append(Node(
                id=node_id,
                label=f"WRITE\n\"{word}\"",
                type="write",
                zone="timeline",
                radius=24,
                tooltip=[
                    f"Step {i+1}: WRITE",
                    f"Emit translation token: \"{word}\"",
                    f"Target token index: {orig_idx+1}",
                    f"Attention on last frames < alpha={tl_alpha:.1f}",
                ],
                status="ok",
            ))

        # Link from previous
        prev_id = "start" if i == 0 else f"step_{i-1}"
        tl_links.append(Link(
            source=prev_id, target=node_id,
            color=COLORS["read"] if action == "READ" else COLORS["write"],
            width=2.5,
            label=action,
        ))

    # End node
    tl_nodes.append(Node(
        id="end", label="END", type="end",
        zone="timeline", radius=20,
        tooltip=["Translation complete"],
    ))
    tl_links.append(Link(
        source=f"step_{len(schedule)-1}", target="end",
        color=COLORS["neutral"], width=2,
    ))

    # Also show the source/target sentences as reference nodes
    tl_nodes.append(Node(
        id="source_sent", label=" ".join(SOURCE_WORDS),
        type="source_ref", zone="source_ref", radius=15,
        tooltip=["Full source (English audio)"],
    ))
    tl_nodes.append(Node(
        id="target_sent", label=" ".join(TARGET_WORDS),
        type="target_ref", zone="target_ref", radius=15,
        tooltip=["Full target (German translation)"],
    ))

    tl_zones = [
        Zone(name="source_ref", label="Source (English)", color="#d0ebff"),
        Zone(name="timeline", label="READ/WRITE Schedule", color=COLORS["time_bg"]),
        Zone(name="target_ref", label="Target (German)", color="#fcc2d7"),
    ]

    tl_node_types = {
        "start": NodeType(shape="diamond", color="#dee2e6", border_color="#495057", label="Start/End"),
        "end": NodeType(shape="diamond", color="#dee2e6", border_color="#495057", label="Start/End"),
        "read": NodeType(shape="circle", color="#d3f9d8", border_color=COLORS["read"], icon="R", label="READ (audio)"),
        "write": NodeType(shape="rect", color="#e5dbff", border_color=COLORS["write"], icon="W", label="WRITE (token)"),
        "source_ref": NodeType(shape="rect", color="#a5d8ff", border_color=COLORS["encoder"], label="Source sentence"),
        "target_ref": NodeType(shape="rect", color=COLORS["decoder_bg"], border_color=COLORS["decoder"], label="Target sentence"),
    }

    st_d3_network(
        nodes=tl_nodes,
        links=tl_links,
        zones=tl_zones,
        node_types=tl_node_types,
        show_labels=True,
        show_hulls=True,
        show_particles=True,
        show_legend=True,
        show_search=False,
        layout="force",
        height=500,
        key="timeline_graph",
    )

    # Statistics
    n_reads = sum(1 for a, _, _ in schedule if a == "READ")
    n_writes = sum(1 for a, _, _ in schedule if a == "WRITE")
    total_steps = len(schedule)

    st.markdown("#### Schedule Statistics")
    m1, m2, m3, m4 = st.columns(4)
    m1.metric("Total steps", total_steps)
    m2.metric("READ actions", n_reads)
    m3.metric("WRITE actions", n_writes)
    m4.metric("Latency ratio", f"{n_reads/max(n_writes,1):.1f} reads/write")

    st.markdown("""
    **Interpretation**: With lower alpha, WRITE actions happen sooner (interleaved with fewer READs),
    reducing latency. With higher alpha, the system accumulates more audio before emitting each token,
    increasing latency but improving translation quality.
    """)


# ===================================================================
# TAB 4: THE ATTENTION SINK DISCOVERY
# ===================================================================

with tab4:
    st.markdown("""
    ### The Attention Sink: Before and After Filtering

    A critical finding in the EDAtt paper: the **last encoder frame** acts as an "attention sink",
    absorbing roughly **97% of all cross-attention weight**. This is not linguistically meaningful
    --- it is an artifact of the Transformer architecture (the model dumps "unused" attention
    probability mass onto the boundary frame).

    **Before filtering**: All attention links point to the sink frame, hiding the true alignment.
    **After filtering**: Remove the last frame and renormalize. A clear **pseudo-diagonal pattern**
    emerges, revealing the monotonic alignment between audio and translation.

    Toggle between the two views below.
    """)

    show_sink = st.toggle(
        "Show attention sink (raw attention)",
        value=True,
        help="Toggle to see the raw attention (with sink) vs filtered attention (without sink).",
        key="sink_toggle",
    )

    if show_sink:
        st.error("RAW ATTENTION: The last frame absorbs ~97% of weight. Links are dominated by the sink. No useful alignment visible.")
        matrix = ATTENTION_WITH_SINK
        n_src = len(SOURCE_WORDS) + 1  # +1 for sink frame
        src_labels = SOURCE_WORDS + ["[SINK]"]
    else:
        st.success("FILTERED ATTENTION: After removing the sink frame and renormalizing, a clear pseudo-diagonal alignment pattern emerges.")
        matrix = FILTERED_ATTENTION
        n_src = len(SOURCE_WORDS)
        src_labels = SOURCE_WORDS

    sink_nodes = []
    sink_links = []

    # Source nodes
    for i in range(n_src):
        is_sink = show_sink and i == n_src - 1
        sink_nodes.append(Node(
            id=f"sink_src_{i}",
            label=f"x{i+1}: {src_labels[i]}",
            type="sink_frame" if is_sink else "audio_frame",
            zone="audio_zone",
            radius=30 if is_sink else 22,
            tooltip=[
                f"Frame {i+1}: \"{src_labels[i]}\"",
                "ATTENTION SINK - absorbs ~97% of attention" if is_sink else "Normal audio frame",
            ],
            status="error" if is_sink else "",
        ))

    # Target nodes
    for j in range(len(TARGET_WORDS)):
        sink_nodes.append(Node(
            id=f"sink_tgt_{j}",
            label=f"y{j+1}: {TARGET_WORDS[j]}",
            type="trans_token",
            zone="trans_zone",
            radius=22,
            tooltip=[f"Token: \"{TARGET_WORDS[j]}\""],
        ))

    # Links
    for i in range(n_src):
        for j in range(len(TARGET_WORDS)):
            w = float(matrix[i, j])
            if w > 0.005:
                is_sink_link = show_sink and i == n_src - 1
                # Determine if this is a "diagonal" link (alignment)
                is_diagonal = not show_sink and abs(i - j * (n_src / len(TARGET_WORDS))) < 1.5
                sink_links.append(Link(
                    source=f"sink_src_{i}", target=f"sink_tgt_{j}",
                    width=1 + w * 10,
                    opacity=min(0.95, 0.15 + w * 1.5),
                    color=COLORS["sink"] if is_sink_link else (COLORS["ok"] if is_diagonal else COLORS["encoder"]),
                ))

    sink_zones = [
        Zone(name="audio_zone", label="Encoder Audio Frames", color=COLORS["encoder_bg"]),
        Zone(name="trans_zone", label="Decoder Translation Tokens", color=COLORS["decoder_bg"]),
    ]

    sink_node_types = {
        "audio_frame": NodeType(shape="circle", color="#74c0fc", border_color=COLORS["encoder"], label="Audio Frame"),
        "sink_frame": NodeType(shape="hexagon", color="#ffc9c9", border_color=COLORS["sink"], label="Sink Frame (~97%)"),
        "trans_token": NodeType(shape="rect", color=COLORS["decoder_bg"], border_color=COLORS["decoder"], label="Translation Token"),
    }

    st_d3_network(
        nodes=sink_nodes,
        links=sink_links,
        zones=sink_zones,
        node_types=sink_node_types,
        show_labels=False,
        show_hulls=True,
        show_particles=show_sink,
        show_legend=True,
        show_search=False,
        layout="force",
        height=550,
        key="sink_graph",
    )

    # Explanation
    if show_sink:
        st.markdown("""
        **What you see above**: Thick red links from the **[SINK]** frame dominate the graph.
        The actual alignment information is invisible, buried under 3% of total attention weight.
        This is why naive use of attention weights for alignment fails.

        Toggle off "Show attention sink" to see the filtered version.
        """)
    else:
        st.markdown("""
        **What you see above**: After removing the sink frame and renormalizing, green links
        reveal the **pseudo-diagonal alignment**: early audio frames align with early tokens,
        and later frames align with later tokens. This is the monotonic alignment pattern
        that EDAtt exploits for its READ/WRITE policy.

        This discovery --- that a clean alignment hides behind the attention sink --- is one of
        the paper's key contributions.
        """)


# ===================================================================
# FOOTER: PAPER SUMMARY
# ===================================================================

st.divider()

st.markdown("""
### Key Takeaways from EDAtt (Papi et al., ACL 2023)

| Aspect | Finding |
|--------|---------|
| **Policy** | Use encoder-decoder cross-attention to decide READ vs WRITE --- no external classifier needed |
| **Attention sink** | Last encoder frame absorbs ~97% of attention; filter it out to reveal alignment |
| **Optimal layer** | Middle decoder layers (layer 4 of 6) give the best alignment signal |
| **Optimal head** | Average across all 8 heads outperforms any single head |
| **Lambda** | Checking the last 2 frames (lambda=2) is optimal |
| **Alpha** | Controls quality-latency tradeoff; lower = faster but riskier |
| **Result** | State-of-the-art simultaneous translation quality with competitive latency on MuST-C en-de |

---
*Built with [streamlit-d3-network](https://github.com/QuentinFuxa/streamlit-d3-network) --- Interactive D3.js network graphs for Streamlit.*
""")
