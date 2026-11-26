"use client";

import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RotateCcw, Crosshair, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@messiah/ui";
import {
  buildConstellationGraph,
  getStatusColorHex,
  type ConstellationNode,
} from "./swarmTopologyModel";
import type { SwarmRunDetail } from "@messiah/shared";

interface SwarmConstellation3DProps {
  run: SwarmRunDetail;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onWebGLFailure?: (reason: string) => void;
}

interface SignalPulse {
  mesh: THREE.Mesh;
  curve: THREE.QuadraticBezierCurve3;
  progress: number;
  speed: number;
}

export default function SwarmConstellation3D({
  run,
  selectedNodeId,
  onSelectNode,
  onWebGLFailure,
}: SwarmConstellation3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredNode, setHoveredNode] = useState<ConstellationNode | null>(null);

  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const nodeMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());

  const graph = useMemo(() => buildConstellationGraph(run), [run]);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;

  const resetCamera = useCallback(() => {
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    if (!cam || !ctrl) return;
    cam.position.set(0, 4.2, 12.2);
    ctrl.target.set(0, 0.8, 0);
    ctrl.update();
  }, []);

  const focusSelectedNode = useCallback(() => {
    const targetId = selectedNodeId || "supervisor";
    const node = graphRef.current.nodes.find((n) => n.id === targetId);
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    if (!node || !cam || !ctrl) return;
    ctrl.target.set(node.x3d, node.y3d, node.z3d);
    cam.position.set(node.x3d + 2.8, node.y3d + 1.8, node.z3d + 5.2);
    ctrl.update();
  }, [selectedNodeId]);

  const nudgeZoom = useCallback((factor: number) => {
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    if (!cam || !ctrl) return;
    const dir = cam.position.clone().sub(ctrl.target);
    const nextDist = Math.max(4, Math.min(24, dir.length() * factor));
    dir.setLength(nextDist);
    cam.position.copy(ctrl.target).add(dir);
    ctrl.update();
  }, []);

  // Initialize Three.js WebGL context cleanly once per mount
  const sceneObjectsRef = useRef<{
    scene: THREE.Scene;
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    dynamicGroup: THREE.Group;
    pulses: SignalPulse[];
    haloMeshes: Map<string, THREE.Mesh>;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch (err) {
      onWebGLFailure?.(
        err instanceof Error ? err.message : "Failed to initialize WebGL 3D context."
      );
      return;
    }

    const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
    const dprCap = isMobile ? 1.25 : 1.75;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.setSize(container.clientWidth || 640, container.clientHeight || 420);
    renderer.setClearColor(0x090a0f, 1);
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      onWebGLFailure?.("WebGL graphics context was lost.");
    };
    renderer.domElement.addEventListener("webglcontextlost", handleContextLost);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x090a0f, 0.028);

    const camera = new THREE.PerspectiveCamera(
      48,
      (container.clientWidth || 640) / (container.clientHeight || 420),
      0.1,
      100
    );
    camera.position.set(0, 4.2, 12.2);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 4;
    controls.maxDistance = 24;
    controls.target.set(0, 0.8, 0);
    controls.update();
    controlsRef.current = controls;

    // Subtle Obsidian Starfield + Orbital Grid
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    const keyLight = new THREE.PointLight(0x00ffa3, 1.5, 40);
    keyLight.position.set(4, 8, 6);
    const rimLight = new THREE.PointLight(0x38bdf8, 1.1, 40);
    rimLight.position.set(-6, -2, -5);
    scene.add(ambient, keyLight, rimLight);

    const gridHelper = new THREE.GridHelper(18, 18, 0x1e2536, 0x111520);
    gridHelper.position.y = -4.5;
    scene.add(gridHelper);

    const starCount = isMobile ? 90 : 180;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPositions[i * 3] = (Math.random() - 0.5) * 42;
      starPositions[i * 3 + 1] = (Math.random() - 0.5) * 32;
      starPositions[i * 3 + 2] = (Math.random() - 0.5) * 42;
    }
    const starGeom = new THREE.BufferGeometry();
    starGeom.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x334155, size: 0.09, transparent: true, opacity: 0.65 });
    const stars = new THREE.Points(starGeom, starMat);
    scene.add(stars);

    const dynamicGroup = new THREE.Group();
    scene.add(dynamicGroup);

    const pulses: SignalPulse[] = [];
    const haloMeshes = new Map<string, THREE.Mesh>();
    sceneObjectsRef.current = {
      scene,
      renderer,
      camera,
      controls,
      dynamicGroup,
      pulses,
      haloMeshes,
    };

    // Raycaster pointer interaction
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDownPos = { x: 0, y: 0 };

    const getHitNode = (ev: PointerEvent | MouseEvent): ConstellationNode | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const targets = Array.from(nodeMeshesRef.current.values());
      const hits = raycaster.intersectObjects(targets, false);
      if (hits.length === 0) return null;
      const hitId = hits[0]!.object.userData?.nodeId as string | undefined;
      if (!hitId) return null;
      return graphRef.current.nodes.find((n) => n.id === hitId) || null;
    };

    const handlePointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    };

    const handlePointerUp = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (moved > 6) return; // Dragged camera, don't trigger node click
      const hit = getHitNode(e);
      if (hit) {
        onSelectRef.current(hit.id);
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      const hit = getHitNode(e);
      renderer.domElement.style.cursor = hit ? "pointer" : "grab";
      setHoveredNode(hit);
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth || 640;
      const h = container.clientHeight || 420;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    let animFrameId = 0;
    let lastTime = performance.now();

    const animate = (now: number) => {
      animFrameId = requestAnimationFrame(animate);
      if (document.hidden) return; // Pause loop cleanly when tab not visible

      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      controls.update();

      // Advance active signal pulses along live edges
      const current = sceneObjectsRef.current;
      if (current) {
        for (const p of current.pulses) {
          p.progress = (p.progress + dt * p.speed) % 1;
          const pos = p.curve.getPoint(p.progress);
          p.mesh.position.copy(pos);
        }

        // Gentle pulsing halo only on RUNNING / AWAITING_APPROVAL halos
        const pulseScale = 1 + Math.sin(now * 0.004) * 0.14;
        for (const [id, halo] of current.haloMeshes.entries()) {
          const n = graphRef.current.nodes.find((item) => item.id === id);
          if (n && (n.status === "RUNNING" || n.status === "AWAITING_APPROVAL")) {
            halo.scale.setScalar(pulseScale);
          }
        }
      }

      renderer.render(scene, camera);
    };
    animFrameId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("webglcontextlost", handleContextLost);

      controls.dispose();
      nodeMeshesRef.current.clear();

      // Full geometry & material disposal
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) {
          (obj as THREE.Mesh).geometry.dispose();
        }
        const mat = (obj as THREE.Mesh).material;
        if (Array.isArray(mat)) {
          mat.forEach((m) => m.dispose());
        } else if (mat) {
          mat.dispose();
        }
      });

      renderer.dispose();
      sceneObjectsRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
    };
  }, [onWebGLFailure]);

  // Synchronize live run graph state into Three.js meshes cleanly without rebuilding renderer
  useEffect(() => {
    const objs = sceneObjectsRef.current;
    if (!objs) return;

    const { dynamicGroup, pulses, haloMeshes } = objs;

    // Dispose old dynamic geometries/materials
    while (dynamicGroup.children.length > 0) {
      const child = dynamicGroup.children[0]!;
      dynamicGroup.remove(child);
      if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
      const mat = (child as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    }
    pulses.length = 0;
    haloMeshes.clear();
    nodeMeshesRef.current.clear();

    const nodeCoordMap = new Map<string, THREE.Vector3>();

    for (const node of graph.nodes) {
      const pos = new THREE.Vector3(node.x3d, node.y3d, node.z3d);
      nodeCoordMap.set(node.id, pos);

      const isSupervisor = node.kind === "supervisor";
      const isSelected = selectedNodeId === node.id;
      const statusHex = getStatusColorHex(node.status);
      const color = new THREE.Color(statusHex);

      const geom = isSupervisor
        ? new THREE.OctahedronGeometry(0.68, 1)
        : new THREE.SphereGeometry(0.42, 24, 24);
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: node.status === "RUNNING" || node.status === "AWAITING_APPROVAL" ? 0.55 : 0.25,
        roughness: 0.28,
        metalness: 0.45,
      });

      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.copy(pos);
      mesh.userData = { nodeId: node.id };
      dynamicGroup.add(mesh);
      nodeMeshesRef.current.set(node.id, mesh);

      // Selection or active status orbital ring halo
      if (isSelected || node.status === "RUNNING" || node.status === "AWAITING_APPROVAL") {
        const ringGeom = new THREE.RingGeometry(
          isSupervisor ? 0.92 : 0.62,
          isSupervisor ? 1.04 : 0.72,
          32
        );
        const ringMat = new THREE.MeshBasicMaterial({
          color: isSelected ? 0x00ffa3 : color,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: isSelected ? 0.9 : 0.55,
        });
        const ringMesh = new THREE.Mesh(ringGeom, ringMat);
        ringMesh.position.copy(pos);
        ringMesh.rotation.x = Math.PI / 2;
        dynamicGroup.add(ringMesh);
        haloMeshes.set(node.id, ringMesh);
      }
    }

    // Build Bezier edge links + animated particle pulses on active connections
    for (const edge of graph.edges) {
      const src = nodeCoordMap.get(edge.sourceId);
      const tgt = nodeCoordMap.get(edge.targetId);
      if (!src || !tgt) continue;

      const mid = src.clone().add(tgt).multiplyScalar(0.5);
      mid.y += edge.kind === "synthesis" ? 0.85 : -0.35;
      const curve = new THREE.QuadraticBezierCurve3(src, mid, tgt);
      const points = curve.getPoints(24);
      const lineGeom = new THREE.BufferGeometry().setFromPoints(points);

      const lineColor = edge.attention
        ? 0xfbbf24
        : edge.active
        ? 0x00ffa3
        : edge.kind === "synthesis"
        ? 0x38bdf8
        : 0x2a344d;

      const lineMat = new THREE.LineBasicMaterial({
        color: lineColor,
        transparent: true,
        opacity: edge.active || edge.attention ? 0.9 : 0.45,
      });
      const line = new THREE.Line(lineGeom, lineMat);
      dynamicGroup.add(line);

      if (edge.active || edge.attention) {
        const pulseGeom = new THREE.SphereGeometry(0.09, 10, 10);
        const pulseMat = new THREE.MeshBasicMaterial({
          color: edge.attention ? 0xfbbf24 : 0x00ffa3,
        });
        const pulseMesh = new THREE.Mesh(pulseGeom, pulseMat);
        dynamicGroup.add(pulseMesh);
        pulses.push({
          mesh: pulseMesh,
          curve,
          progress: Math.random(),
          speed: edge.attention ? 0.35 : 0.65,
        });
      }
    }
  }, [graph, selectedNodeId]);

  return (
    <div className="relative flex flex-col h-full rounded-xl border border-[#1E2536] bg-[#090A0F] overflow-hidden">
      {/* Three.js Canvas Target */}
      <div
        ref={containerRef}
        className="w-full flex-1 min-h-[360px]"
        role="application"
        aria-label="Interactive 3D Multi-Agent Swarm Constellation"
      />

      {/* Camera & Controls Overlay */}
      <div className="absolute top-3 left-3 flex flex-wrap items-center gap-1.5 bg-[#0E121B]/90 backdrop-blur border border-[#1E2536] rounded-lg px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          onClick={resetCamera}
          className="h-7 px-2 text-[11px] text-[#94A3B8] hover:text-[#F0F4FC]"
          title="Reset camera view"
        >
          <RotateCcw className="w-3.5 h-3.5 mr-1" />
          Reset
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={focusSelectedNode}
          className="h-7 px-2 text-[11px] text-[#94A3B8] hover:text-[#F0F4FC]"
          title="Focus selected agent"
        >
          <Crosshair className="w-3.5 h-3.5 mr-1" />
          Focus
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => nudgeZoom(0.8)}
          className="h-7 w-7 p-0 text-[#94A3B8] hover:text-[#F0F4FC]"
          title="Zoom in"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => nudgeZoom(1.25)}
          className="h-7 w-7 p-0 text-[#94A3B8] hover:text-[#F0F4FC]"
          title="Zoom out"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Hover Tooltip HUD */}
      {hoveredNode && (
        <div className="absolute top-3 right-3 bg-[#12151E]/95 border border-[#1E2536] rounded-lg px-3 py-2 text-xs shadow-xl pointer-events-none max-w-[240px]">
          <div className="font-semibold text-[#F0F4FC] truncate">{hoveredNode.title}</div>
          <div className="text-[11px] font-mono text-[#94A3B8] truncate">
            {hoveredNode.agentName} • {hoveredNode.status}
          </div>
          <div className="text-[10px] font-mono text-[#64748B] mt-0.5">
            Tokens: {hoveredNode.inputTokens + hoveredNode.outputTokens}
          </div>
        </div>
      )}

      {/* Subtle Bottom Status Legend */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t border-[#1E2536] bg-[#0E121B] text-[11px] text-[#8B949E]">
        <div className="flex flex-wrap items-center gap-3 font-mono">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[#00FFA3]" /> Active
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[#FBBF24]" /> Approval
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[#10B981]" /> Completed
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[#EF4444]" /> Failed
          </span>
        </div>
        <span className="font-mono text-[10px] text-[#64748B]">
          Drag orbit • Scroll zoom • Click node to inspect
        </span>
      </div>
    </div>
  );
}
