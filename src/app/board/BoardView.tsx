// The canvas (SPEC 8): sticky notes, task cards and the links between them.
// Positions and sizes are saved when a drag or resize ends (one request per
// moved item, never per pixel). Drawing between two cards links them.

import "@xyflow/react/dist/style.css";
import "./board.css";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type AriaLabelConfig,
  type Connection,
  type EdgeChange,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type OnBeforeDelete,
  type OnNodeDrag,
  type SelectionDragHandler,
  type XYPosition,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { NEW_NOTE, createDependency, createNote, createTask, linkItems, moveItems, placeTask, unlink } from "../actions";
import { FitIcon, KeyboardIcon, PlusIcon, TrayIcon } from "../components/icons";
import { isBoolean, useIsPhone, useStoredState } from "../hooks";
import { nearestFreeSpot, occupiedBoxes, TASK_CARD } from "../../shared/placement";
import { boardEdges, boardNodes, mergeEdges, mergeNodes, nodeItem, type BoardNode, type LinkEdge } from "../lib/board";
import { parseItemKey } from "../lib/items";
import { openItem } from "../router";
import { usePlanner } from "../store";
import { NoteCard, TaskCard } from "./cards";
import { LinkEdgeView } from "./LinkEdge";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { isTypingTarget, resolveShortcut, type BoardAction } from "./shortcuts";
import { TRAY_MIME, Tray } from "./Tray";

const nodeTypes: NodeTypes = { note: NoteCard, task: TaskCard };
const edgeTypes: EdgeTypes = { link: LinkEdgeView };
const DELETE_KEYS = ["Delete", "Backspace"];
/** How long arrow-key moves rest before they are saved. */
const KEY_MOVE_SAVE_MS = 600;
const FIT = { padding: 0.2, maxZoom: 1 } as const;
/** On a phone, fitting never zooms out so far that cards cannot be read. */
const FIT_PHONE = { padding: 0.1, maxZoom: 1, minZoom: 0.5 } as const;
const notToItself = (c: Connection | LinkEdge) => c.source !== c.target;

/** Top-left corners of a new note or a task card centred on a point. */
const noteCorner = (centre: XYPosition): XYPosition => ({ x: Math.round(centre.x - NEW_NOTE.w / 2), y: Math.round(centre.y - NEW_NOTE.h / 2) });
const taskCorner = (centre: XYPosition): XYPosition => ({ x: Math.round(centre.x - TASK_CARD.w / 2), y: Math.round(centre.y - 30) });

/** What screen readers hear on the canvas, in the planner's words. */
const ARIA_LABELS: Partial<AriaLabelConfig> = {
  "node.a11yDescription.default":
    "Press Enter to open this card. Press Space to select it, then use the arrow keys to move it.",
  "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }) => `Moved the card ${direction}, to ${x}, ${y}.`,
  "edge.a11yDescription.default": "Press Enter or Space to select this link, then Delete to unlink the two cards.",
  "controls.ariaLabel": "Zoom",
  "controls.zoomIn.ariaLabel": "Zoom in",
  "controls.zoomOut.ariaLabel": "Zoom out",
  "handle.ariaLabel": "Drag to another card to link them",
};

export default function BoardView() {
  return (
    <ReactFlowProvider>
      <Board />
    </ReactFlowProvider>
  );
}

function Board() {
  const phone = useIsPhone();
  const notes = usePlanner((s) => s.notes);
  const tasks = usePlanner((s) => s.tasks);
  const links = usePlanner((s) => s.links);
  const flow = useReactFlow<BoardNode, LinkEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const [trayOpen, setTrayOpen] = useStoredState("planner.board.tray", !phone, isBoolean);
  const [addingTask, setAddingTask] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const fresh = useMemo(() => boardNodes(notes.values(), tasks.values()), [notes, tasks]);
  const [nodes, setNodes] = useState<BoardNode[]>(fresh);
  useEffect(() => setNodes((shown) => mergeNodes(shown, fresh)), [fresh]);

  const nodeIds = useMemo(() => new Set(fresh.map((n) => n.id)), [fresh]);
  const freshEdges = useMemo(() => boardEdges(links.values(), nodeIds), [links, nodeIds]);
  const [edges, setEdges] = useState<LinkEdge[]>(freshEdges);
  useEffect(() => setEdges((shown) => mergeEdges(shown, freshEdges)), [freshEdges]);

  const unplacedCount = useMemo(() => {
    let n = 0;
    for (const t of tasks.values()) if (t.status === "open" && t.x === null) n += 1;
    return n;
  }, [tasks]);

  // Arrow keys move selected cards without a drag. Those moves are saved once
  // the keys have rested. A drag end reports dragging: false as well, just
  // before onNodeDragStop, which saves it at once and cancels this timer.
  const keyMoved = useRef(new Set<string>());
  const keyMoveTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(keyMoveTimer.current), []);

  const onNodesChange = useCallback(
    (changes: NodeChange<BoardNode>[]) => {
      setNodes((shown) => applyNodeChanges(changes, shown));
      let moved = false;
      for (const change of changes) {
        if (change.type === "position" && change.dragging === false) {
          keyMoved.current.add(change.id);
          moved = true;
        }
      }
      if (!moved) return;
      window.clearTimeout(keyMoveTimer.current);
      keyMoveTimer.current = window.setTimeout(() => {
        const ids = [...keyMoved.current];
        keyMoved.current.clear();
        void moveItems(
          ids.flatMap((id) => {
            const node = flow.getNode(id);
            return node ? [{ ref: nodeItem(node), x: node.position.x, y: node.position.y }] : [];
          }),
        );
      }, KEY_MOVE_SAVE_MS);
    },
    [flow],
  );
  const onEdgesChange = useCallback((changes: EdgeChange<LinkEdge>[]) => setEdges((shown) => applyEdgeChanges(changes, shown)), []);

  /** A drag has ended: save where the cards went, one request per card that moved. */
  const saveDrag = useCallback((dragged: readonly BoardNode[]) => {
    window.clearTimeout(keyMoveTimer.current);
    keyMoved.current.clear();
    void moveItems(dragged.map((n) => ({ ref: nodeItem(n), x: n.position.x, y: n.position.y })));
  }, []);
  const onNodeDragStop: OnNodeDrag<BoardNode> = useCallback((_event, _node, dragged) => saveDrag(dragged), [saveDrag]);
  const onSelectionDragStop: SelectionDragHandler<BoardNode> = useCallback((_event, dragged) => saveDrag(dragged), [saveDrag]);

  const onConnect = useCallback((connection: Connection) => {
    const a = parseItemKey(connection.source);
    const b = parseItemKey(connection.target);
    if (!a || !b || connection.source === connection.target) return;
    // Drawing from one task to another makes a dependency: the source comes first.
    void (a.type === "task" && b.type === "task" ? createDependency(a, b) : linkItems(a, b));
  }, []);

  // Delete/Backspace unlinks the selected links and never removes cards.
  const onBeforeDelete: OnBeforeDelete<BoardNode, LinkEdge> = useCallback(async ({ edges: doomed }) => {
    for (const edge of doomed) if (edge.selected && edge.data) void unlink(edge.data.id);
    return false;
  }, []);

  const onNodeClick = useCallback((_event: MouseEvent, node: BoardNode) => openItem(nodeItem(node)), []);

  /** The board position at the middle of the visible canvas. */
  const viewCentre = useCallback((): XYPosition => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [flow]);

  /**
   * The free spot nearest to the middle of the view for a new card, so cards
   * added one after another from the toolbar or the tray never hide each
   * other. A double-click or a drop goes exactly where the pointer is.
   */
  const clearSpotInView = useCallback(
    (corner: (centre: XYPosition) => XYPosition, size: { w: number; h: number }): XYPosition =>
      nearestFreeSpot({ ...corner(viewCentre()), ...size }, occupiedBoxes(notes.values(), tasks.values())),
    [viewCentre, notes, tasks],
  );

  const addNote = useCallback(async (corner: XYPosition) => {
    const note = await createNote(corner);
    if (note) openItem({ type: "note", id: note.id });
  }, []);

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!(e.target instanceof Element) || !e.target.classList.contains("react-flow__pane")) return;
    void addNote(noteCorner(flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })));
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TRAY_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const taskId = e.dataTransfer.getData(TRAY_MIME);
    if (!taskId) return;
    e.preventDefault();
    void placeTask(taskId, taskCorner(flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })));
  };

  /** Escape on the board: nothing selected any more (the item panel has its own Escape). */
  const clearSelection = () => {
    setNodes((shown) => shown.map((node) => (node.selected ? { ...node, selected: false } : node)));
    setEdges((shown) => shown.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)));
  };

  /** What a shortcut does: the same moves the toolbar buttons make. */
  const runBoardAction = (action: BoardAction) => {
    switch (action) {
      case "new-note":
        void addNote(clearSpotInView(noteCorner, NEW_NOTE));
        break;
      case "new-task":
        setAddingTask(true);
        break;
      case "fit":
        void flow.fitView({ ...(phone ? FIT_PHONE : FIT), duration: 300 });
        break;
      case "zoom-in":
        flow.zoomIn({ duration: 200 });
        break;
      case "zoom-out":
        flow.zoomOut({ duration: 200 });
        break;
      case "zoom-100":
        flow.zoomTo(1, { duration: 200 });
        break;
      case "clear-selection":
        clearSelection();
        break;
      case "show-shortcuts":
        setShortcutsOpen(true);
        break;
    }
  };

  // The keys in the shortcuts table (shortcuts.ts). They belong to the board:
  // they work while focus sits on the canvas or on the page around it (a
  // click on the canvas leaves focus on <main>), and never while a field has
  // focus or a dialog is open. The listener is re-hung after each render so
  // it always reads the latest board state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const canvas = wrapper.current;
      // Focus in the header, the tray or any other control keeps its own keys.
      if (canvas === null || active === null || (!canvas.contains(active) && !active.contains(canvas))) return;
      const action = resolveShortcut({
        key: e.key,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        inTextField: isTypingTarget(active),
        dialogOpen: document.querySelector('[role="dialog"], dialog[open]') !== null,
      });
      if (action === null) return;
      e.preventDefault();
      runBoardAction(action);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Enter on a focused card opens it, like a click.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || !(e.target instanceof HTMLElement) || !e.target.classList.contains("react-flow__node")) return;
    const ref = parseItemKey(e.target.dataset.id ?? "");
    if (ref) openItem(ref);
  };

  return (
    <div className="board">
      <div className="board-canvas" ref={wrapper}>
        <ReactFlow<BoardNode, LinkEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onSelectionDragStop={onSelectionDragStop}
          onConnect={onConnect}
          onBeforeDelete={onBeforeDelete}
          onNodeClick={onNodeClick}
          isValidConnection={notToItself}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={DELETE_KEYS}
          elevateEdgesOnSelect
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={phone ? FIT_PHONE : FIT}
          minZoom={0.1}
          maxZoom={2}
          colorMode="system"
          onDoubleClick={onDoubleClick}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onKeyDown={onKeyDown}
          aria-label="Board"
          ariaLabelConfig={ARIA_LABELS}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
          <Controls showFitView={false} showInteractive={false} position="bottom-left" />
          <Panel position="top-left" className="board-toolbar">
            <button type="button" className="button" onClick={() => void addNote(clearSpotInView(noteCorner, NEW_NOTE))}>
              <PlusIcon /> Note
            </button>
            {addingTask ? (
              <NewTaskForm
                onDone={() => setAddingTask(false)}
                onCreate={async (title) => {
                  const task = await createTask({ title, ...clearSpotInView(taskCorner, TASK_CARD) });
                  if (task) openItem({ type: "task", id: task.id });
                  return task !== undefined;
                }}
              />
            ) : (
              <button type="button" className="button" onClick={() => setAddingTask(true)}>
                <PlusIcon /> Task
              </button>
            )}
            <button type="button" className="button" onClick={() => void flow.fitView({ ...(phone ? FIT_PHONE : FIT), duration: 300 })}>
              <FitIcon /> Fit
            </button>
            <button type="button" className="button" onClick={() => setShortcutsOpen(true)}>
              <KeyboardIcon /> Shortcuts
            </button>
            {!trayOpen && (
              <button type="button" className="button" onClick={() => setTrayOpen(true)} aria-label={`Show the tray (${unplacedCount} tasks not on the board)`}>
                <TrayIcon /> Tray <span className="count">{unplacedCount}</span>
              </button>
            )}
          </Panel>
          {nodes.length === 0 && (
            <Panel position="top-center" className="board-empty">
              Double-click the board to add a note, or use + Note and + Task.
            </Panel>
          )}
        </ReactFlow>
      </div>
      {trayOpen && <Tray onClose={() => setTrayOpen(false)} onPlace={(id) => void placeTask(id, clearSpotInView(taskCorner, TASK_CARD))} />}
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

function NewTaskForm({ onCreate, onDone }: { onCreate: (title: string) => Promise<boolean>; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await onCreate(text);
    setBusy(false);
    // On failure the title stays so nothing typed is lost.
    if (ok) {
      setTitle("");
      onDone();
    }
  };
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <input
        className="input"
        autoFocus
        value={title}
        placeholder="Task title"
        aria-label="New task title"
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
        }}
      />
      <button type="submit" className="button button--primary" disabled={busy || title.trim() === ""}>
        Add
      </button>
      <button type="button" className="button button--quiet" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}
