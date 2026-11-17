import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { pressureColor } from './model.js';
import { escapeHtml } from './format.js';

const ORIGIN = { lon: 115.86, lat: 28.70 };
const KX = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const KY = 110540;
const MODE_COLORS = { walk: '#2f7d5a', bike: '#b67800', drive: '#c8102e', transit: '#3b6ea8', pedestrian: '#2f7d5a', bicycle: '#b67800', auto: '#c8102e' };
const ROAD_WIDTH = {
  motorway: 24, trunk: 20, primary: 16, secondary: 12, tertiary: 9,
  unclassified: 7, residential: 6, living_street: 5, service: 4,
};

function project(lon, lat) {
  return [ (lon - ORIGIN.lon) * KX, -(lat - ORIGIN.lat) * KY ];
}

function ribbon(geometry, width, y) {
  const positions = [];
  const indices = [];
  const pts = geometry.map(([lon, lat]) => project(lon, lat));
  if (pts.length < 2) return null;
  const half = width / 2;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * half;
    const nz = (dx / len) * half;
    positions.push(p[0] + nx, y, p[1] + nz);
    positions.push(p[0] - nx, y, p[1] - nz);
  }
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  return { positions, indices, triangles: (pts.length - 1) * 2 };
}

function colorOf(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

function simplifyRoute(geometry, minDistance = 30) {
  if (!geometry || geometry.length <= 2) return geometry || [];
  const out = [geometry[0]];
  let lastLon = geometry[0][0];
  let lastLat = geometry[0][1];
  for (let i = 1; i < geometry.length - 1; i += 1) {
    const [lon, lat] = geometry[i];
    const dx = (lon - lastLon) * 111320 * Math.cos((lat * Math.PI) / 180);
    const dz = (lat - lastLat) * 110540;
    if (Math.hypot(dx, dz) >= minDistance) {
      out.push(geometry[i]);
      lastLon = lon;
      lastLat = lat;
    }
  }
  out.push(geometry[geometry.length - 1]);
  return out;
}

function clearGroup(group) {
  if (!group) return;
  for (const child of [...group.children]) {
    group.remove(child);
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material.dispose();
    }
  }
}

// Height rules for the shared OSM city massing (metres, not exaggerated).
function cityBuildingHeight(building) {
  if (building.height && building.height > 1) return Math.min(160, building.height);
  if (building.levels && building.levels > 0) return Math.min(160, building.levels * 3.2);
  const type = String(building.building || '').toLowerCase();
  if (/apartment|residential/.test(type)) return 21;
  if (/house|detached/.test(type)) return 9;
  if (/office/.test(type)) return 36;
  if (/hotel/.test(type)) return 42;
  if (/commercial|retail|mall/.test(type)) return 18;
  if (/school|kindergarten/.test(type)) return 12;
  if (/hospital/.test(type)) return 26;
  if (/industrial|warehouse/.test(type)) return 10;
  if (/station|transport/.test(type)) return 18;
  if (/university|college/.test(type)) return 16;
  return 12;
}

function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [latI, lonI] = poly[i];
    const [latJ, lonJ] = poly[j];
    const intersects = ((latI > lat) !== (latJ > lat))
      && (lon < ((lonJ - lonI) * (lat - latI)) / ((latJ - latI) || 1e-9) + lonI);
    if (intersects) inside = !inside;
  }
  return inside;
}

function waterIsLarge(poly) {
  let minLat = Infinity; let maxLat = -Infinity; let minLon = Infinity; let maxLon = -Infinity;
  for (const [lat, lon] of poly) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { poly, minLat, maxLat, minLon, maxLon, area: (maxLat - minLat) * (maxLon - minLon) };
}

function metresBetween(a, b) {
  const dy = (b[0] - a[0]) * 110540;
  const dx = (b[1] - a[1]) * 111320 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}

function addCityPrism(positions, colors, indices, poly, height, color) {
  if (!poly || poly.length < 3) return;
  const n = poly.length;
  const start = positions.length / 3;
  const top = height;
  let sumX = 0;
  let sumZ = 0;
  for (const point of poly) {
    const [x, z] = project(point[1], point[0]);
    sumX += x; sumZ += z;
    positions.push(x, 0, z);
    colors.push(color.r, color.g, color.b);
    positions.push(x, top, z);
    colors.push(Math.min(1, color.r * 1.1), Math.min(1, color.g * 1.1), Math.min(1, color.b * 1.1));
  }
  for (let i = 0; i < n; i += 1) {
    const k = (i + 1) % n;
    indices.push(start + i * 2, start + k * 2, start + k * 2 + 1);
    indices.push(start + i * 2, start + k * 2 + 1, start + i * 2 + 1);
  }
  const center = positions.length / 3;
  positions.push(sumX / n, top, sumZ / n);
  colors.push(Math.min(1, color.r * 1.08), Math.min(1, color.g * 1.08), Math.min(1, color.b * 1.08));
  for (let i = 0; i < n; i += 1) {
    indices.push(center, start + i * 2 + 1, start + ((i + 1) % n) * 2 + 1);
  }
}

function addCityFlat(positions, colors, indices, polys, color, y) {
  const c = new THREE.Color(color);
  for (const poly of polys || []) {
    if (!poly || poly.length < 3) continue;
    const start = positions.length / 3;
    let sumX = 0;
    let sumZ = 0;
    for (const point of poly) {
      const [x, z] = project(point[1], point[0]);
      sumX += x; sumZ += z;
      positions.push(x, y, z);
      colors.push(c.r, c.g, c.b);
    }
    const center = positions.length / 3;
    positions.push(sumX / poly.length, y, sumZ / poly.length);
    colors.push(c.r, c.g, c.b);
    for (let i = 0; i < poly.length; i += 1) {
      indices.push(center, start + i, start + ((i + 1) % poly.length));
    }
  }
}

export class Map3D {
  constructor(container, options = {}) {
    this.container = container;
    this.onSelect = options.onSelect || (() => {});
    this.onPlace = options.onPlace || null;
    this.onStation = options.onStation || null;
    this.onHub = options.onHub || null;
    this.onRoute = options.onRoute || null;
    this.placeHandler = null;
    this.stationHandler = null;
    this.hubHandler = null;
    this.routeHandler = null;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.labels = [];
    this.labelLayer = null;
    this.network = null;
    this.segmentMesh = null;
    this.segmentVertexRanges = [];
    this.segmentFaceRanges = [];
    this.segmentForFace = [];
    this.columns = null;
    this.columnSegments = [];
    this.metroGroup = null;
    this.placeGroup = null;
    this.routeGroup = null;
    this.intersectionGroup = null;
    this.selectedId = null;
    this.metrics = new Map();
    this.running = false;
    this.lastFrame = performance.now();
    this.frames = 0;
    this.fps = 0;
    this.fpsAccum = 0;
    this.fpsFrames = 0;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.initialized = false;
    this.base = 'map';
    this.tilesMeta = null;
    this.textures = new Map();
    this.tripGroup = null;
    this.tripMarker = null;
    this.tripMarkerCore = null;
    this.tripLegs = [];
    this.tripFollow = false;
    this._tripLegIndex = -1;
    this.city = null;
    this.metro = null;
    this.hubParkingFilter = null;
    this.cityGroup = null;
    this.cityFlatGroup = null;
    this.cityBuildingGroup = null;
    this.cityRoadGroup = null;
    this.cityRailGroup = null;
    this.hubParkingGroup = null;
    this.hubPointGroup = null;
    this.locationGroup = null;
    this.placePickMeshes = [];
    this.stationPickMeshes = [];
    this.hubPickMeshes = [];
    this.routePickMeshes = [];
    this.hoverRing = null;
    this.hoverMesh = null;
    this.hoverTarget = null;
    this._hoverTip = null;
    this.pulses = [];
    this.columnAnim = null;
    this._pointerDown = null;
    this._lastHover = 0;
    this._onClick = this._onClick.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    this._resize = this._resize.bind(this);
    this._loop = this._loop.bind(this);
  }

  init(tilesMeta) {
    if (this.initialized) return;
    this.tilesMeta = tilesMeta;
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 520;
    this.scene = new THREE.Scene();
    this.scene.background = this._skyTexture();
    this.scene.fog = new THREE.Fog(0x121b24, 16000, 46000);

    this.camera = new THREE.PerspectiveCamera(42, width / height, 50, 80000);
    this.camera.position.set(0, 2600, 3800);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.14;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 500;
    this.controls.maxDistance = 42000;
    this.controls.maxPolarAngle = Math.PI / 2.08;
    this.controls.target.set(0, 0, 0);
    this.controls.update();

    this.labelLayer = document.createElement('div');
    this.labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;overflow:hidden';
    this.container.appendChild(this.labelLayer);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.36);
    this.scene.add(this.ambient);
    this.hemisphere = new THREE.HemisphereLight(0x9ec3e6, 0x241a12, 0.82);
    this.scene.add(this.hemisphere);
    this.directional = new THREE.DirectionalLight(0xffd7a6, 1.72);
    this.directional.position.set(-7200, 11500, 5800);
    this.directional.castShadow = true;
    this.directional.shadow.mapSize.set(2048, 2048);
    this.directional.shadow.camera.near = 400;
    this.directional.shadow.camera.far = 90000;
    this.directional.shadow.camera.left = -30000;
    this.directional.shadow.camera.right = 30000;
    this.directional.shadow.camera.top = 30000;
    this.directional.shadow.camera.bottom = -30000;
    this.directional.shadow.bias = -0.0005;
    this.directional.shadow.normalBias = 4;
    this.directional.shadow.camera.updateProjectionMatrix();
    this.scene.add(this.directional);
    this.scene.add(this.directional.target);
    this.fillLight = new THREE.DirectionalLight(0x5f86b8, 0.5);
    this.fillLight.position.set(8000, 4000, -6000);
    this.scene.add(this.fillLight);

    this.buildingGroup = new THREE.Group();
    this.metroGroup = new THREE.Group();
    this.placeGroup = new THREE.Group();
    this.routeGroup = new THREE.Group();
    this.intersectionGroup = new THREE.Group();
    this.tripGroup = new THREE.Group();
    this.cityGroup = new THREE.Group();
    this.cityFlatGroup = new THREE.Group();
    this.cityBuildingGroup = new THREE.Group();
    this.cityRoadGroup = new THREE.Group();
    this.cityRailGroup = new THREE.Group();
    this.hubParkingGroup = new THREE.Group();
    this.hubPointGroup = new THREE.Group();
    this.bridgeGroup = new THREE.Group();
    this.treeGroup = new THREE.Group();
    this.cityLightGroup = new THREE.Group();
    this.vehicleGroup = new THREE.Group();
    this.locationGroup = new THREE.Group();
    this.pulseGroup = new THREE.Group();
    this.cityGroup.add(this.cityFlatGroup, this.cityBuildingGroup, this.cityRoadGroup, this.cityRailGroup, this.hubParkingGroup, this.hubPointGroup,
      this.bridgeGroup, this.treeGroup, this.cityLightGroup, this.vehicleGroup);
    this.scene.add(this.buildingGroup, this.metroGroup, this.placeGroup, this.routeGroup, this.intersectionGroup, this.tripGroup,
      this.cityGroup, this.locationGroup, this.pulseGroup);

    this._hoverTip = document.createElement('div');
    this._hoverTip.className = 'map3d-tip';
    this._hoverTip.hidden = true;
    this.container.appendChild(this._hoverTip);

    this._addGround(tilesMeta);
    if (this.city) this.setCity(this.city);
    this.renderer.domElement.addEventListener('click', this._onClick);
    this.renderer.domElement.addEventListener('pointermove', this._onPointerMove);
    this.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);
    this.renderer.domElement.addEventListener('pointerleave', this._onPointerLeave);
    window.addEventListener('resize', this._resize);
    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this._resize());
      this.resizeObserver.observe(this.container);
    }
    this.initialized = true;
    this.start();
  }

  _skyTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, '#04070c');
    gradient.addColorStop(0.48, '#0a1622');
    gradient.addColorStop(0.76, '#1b2b38');
    gradient.addColorStop(1, '#3a2b23');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 4, 512);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  _addGround(tilesMeta) {
    const bounds = tilesMeta?.stitched?.bounds;
    let west = 115.75, south = 28.60, east = 115.96, north = 28.90;
    if (Array.isArray(bounds) && bounds.length === 4) [west, south, east, north] = bounds;
    const cx = (west + east) / 2;
    const cy = (south + north) / 2;
    const [x0, z0] = project(cx, cy);
    const w = (east - west) * KX;
    const h = (north - south) * KY;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0x3a4145,
      roughness: 0.96,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    this.groundMaterial = material;
    const ground = new THREE.Mesh(geo, material);
    ground.position.set(x0, -2, z0);
    ground.renderOrder = -10;
    ground.receiveShadow = true;
    this.ground = ground;
    this.scene.add(ground);

    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x0 - w / 2, 0, z0 - h / 2),
        new THREE.Vector3(x0 + w / 2, 0, z0 - h / 2),
        new THREE.Vector3(x0 + w / 2, 0, z0 + h / 2),
        new THREE.Vector3(x0 - w / 2, 0, z0 + h / 2),
      ]),
      new THREE.LineBasicMaterial({ color: 0x8a8478, transparent: true, opacity: 0.35 }),
    );
    this.scene.add(border);
    this._applyGroundTexture(this.base);
  }

  _loadTexture(path, key) {
    if (this.textures.has(key)) return this.textures.get(key);
    const version = encodeURIComponent(this.tilesMeta?.fetched_at || '1');
    const texture = new THREE.TextureLoader().load(`${path.replace(/^app\//, '')}?v=${version}`, (loaded) => {
      loaded.colorSpace = THREE.SRGBColorSpace;
      const anisotropy = this.renderer?.capabilities?.getMaxAnisotropy?.() || 1;
      loaded.anisotropy = Math.min(8, anisotropy);
    });
    this.textures.set(key, texture);
    return texture;
  }

  _applyGroundTexture(base) {
    if (!this.groundMaterial) return;
    const satellite = base === 'sat';
    const info = satellite ? this.tilesMeta?.stitchedSatellite : this.tilesMeta?.stitched;
    const path = info?.path || (satellite ? 'app/tiles/satellite_z13.jpg' : 'app/tiles/overview_z13.jpg');
    const texture = this._loadTexture(path, satellite ? 'sat' : 'map');
    this.groundMaterial.map = texture;
    this.groundMaterial.color.set(satellite ? 0xb0b0b0 : 0x5c6266);
    this.groundMaterial.needsUpdate = true;
    this.container.classList.toggle('satellite', satellite);
  }

  setBase(base) {
    this.base = base === 'sat' ? 'sat' : 'map';
    this._applyGroundTexture(this.base);
  }

  setNetwork(network) {
    this.network = network;
    if (!this.initialized) return;
    this._buildSegments(network.segments || []);
    this._buildColumns(network.segments || []);
  }

  setCity(hub) {
    this.city = hub || null;
    if (!this.initialized || !this.city) return;
    clearGroup(this.buildingGroup);
    clearGroup(this.cityFlatGroup);
    clearGroup(this.cityBuildingGroup);
    clearGroup(this.cityRoadGroup);
    clearGroup(this.cityRailGroup);
    clearGroup(this.bridgeGroup);
    clearGroup(this.treeGroup);
    clearGroup(this.cityLightGroup);
    clearGroup(this.vehicleGroup);
    this.vehiclePoints = null;
    this.vehicleData = [];
    this._detectRoadBridges();
    this._addCityGround();
    this._buildCityFlat();
    this._buildCityBuildings();
    this._buildBridges();
    this._buildCityRoads();
    this._buildCityTrees();
    this._buildCityLights();
    this._buildVehicles();
    this._buildMetroLayer();
    this._buildHubParking(this.hubParkingFilter);
    if (this.hubPoints?.length) this.setHubPoints(this.hubPoints, this.hubPointOptions || {});
    if (this.renderer?.shadowMap) this.renderer.shadowMap.needsUpdate = true;
  }

  _addCityGround() {
    if (!this.city) return;
    if (this.cityGround) {
      this.scene.remove(this.cityGround);
      this.cityGround.geometry.dispose();
      this.cityGround.material.dispose();
      this.cityGround = null;
    }
    const bbox = this.city.meta?.bbox;
    if (!Array.isArray(bbox) || bbox.length < 4) return;
    const [south, west, north, east] = bbox;
    const [x1, z1] = project(west, north);
    const [x2, z2] = project(east, south);
    const width = Math.abs(x2 - x1);
    const depth = Math.abs(z2 - z1);
    const geometry = new THREE.PlaneGeometry(width, depth);
    geometry.rotateX(-Math.PI / 2);
    const dark = true;
    const material = new THREE.MeshStandardMaterial({ color: dark ? 0x101315 : 0xe6dfd0, roughness: 0.94, metalness: 0.04, side: THREE.DoubleSide });
    const ground = new THREE.Mesh(geometry, material);
    ground.position.set((x1 + x2) / 2, -8, (z1 + z2) / 2);
    ground.renderOrder = -12;
    ground.receiveShadow = true;
    this.cityGround = ground;
    this.scene.add(ground);
  }

  _buildCityFlat() {
    if (!this.city) return;
    clearGroup(this.cityFlatGroup);
    const dark = true;
    const layers = [
      { key: 'zone', polys: (this.city.zones || []).map((z) => z.poly), color: dark ? 0x1b2025 : 0xede7d9, y: 0.2 },
      { key: 'green', polys: (this.city.green || []).map((z) => z.poly), color: dark ? 0x1d2a24 : 0xdbe6d5, y: 0.45 },
      { key: 'water', polys: (this.city.water || []).map((z) => z.poly), color: dark ? 0x18282e : 0xd0e1df, y: 0.7 },
    ];
    for (const layer of layers) {
      const positions = [];
      const colors = [];
      const indices = [];
      addCityFlat(positions, colors, indices, layer.polys, layer.color, layer.y);
      if (!positions.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      const isWater = layer.key === 'water';
      const material = isWater
        ? new THREE.MeshStandardMaterial({
          vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.92,
          roughness: 0.16, metalness: 0.58, depthWrite: false,
        })
        : new THREE.MeshStandardMaterial({
          vertexColors: true, side: THREE.DoubleSide, roughness: 0.92, metalness: 0.02, depthWrite: false,
        });
      const mesh = new THREE.Mesh(geo, material);
      mesh.renderOrder = isWater ? 2 : layer.y < 0.5 ? 0 : 1;
      mesh.receiveShadow = !isWater;
      this.cityFlatGroup.add(mesh);
    }
    const lines = [];
    for (const waterline of this.city.waterlines || []) {
      for (let i = 1; i < waterline.pts.length; i += 1) {
        const [ax, az] = project(waterline.pts[i - 1][1], waterline.pts[i - 1][0]);
        const [bx, bz] = project(waterline.pts[i][1], waterline.pts[i][0]);
        lines.push(ax, 1.1, az, bx, 1.1, bz);
      }
    }
    if (lines.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: dark ? 0x2f4a52 : 0xbfd7d5, transparent: true, opacity: 0.7,
      }));
      mesh.renderOrder = 2;
      this.cityFlatGroup.add(mesh);
    }
  }

  _buildCityBuildings() {
    if (!this.city) return;
    clearGroup(this.cityBuildingGroup);
    const positions = [];
    const colors = [];
    const indices = [];
    const dark = true;
    const base = new THREE.Color(dark ? 0x7b8793 : 0xd3c8b2);
    for (const building of this.city.buildings || []) {
      if (!building.poly || building.poly.length < 3) continue;
      const height = Math.max(3, Math.min(160, cityBuildingHeight(building)));
      const tone = 0.7 + Math.min(0.24, height / 420);
      const color = base.clone().multiplyScalar(tone);
      addCityPrism(positions, colors, indices, building.poly, height, color);
    }
    if (!positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide, roughness: 0.82, metalness: 0.1,
    }));
    mesh.renderOrder = 3;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.cityBuildingGroup.add(mesh);
  }

  _buildCityRoads() {
    if (!this.city) return;
    clearGroup(this.cityRoadGroup);
    const dark = true;
    const majorColor = new THREE.Color(dark ? 0x3a4249 : 0xd0c7b6);
    const minorColor = new THREE.Color(dark ? 0x2a3137 : 0xe4ddd0);
    const major = [];
    const minor = [];
    const majorColors = [];
    const minorColors = [];
    for (const road of this.city.roads || []) {
      const isMajor = ['motorway', 'trunk', 'primary', 'secondary'].includes(road.class);
      const target = isMajor ? major : minor;
      const targetColors = isMajor ? majorColors : minorColors;
      const color = isMajor ? majorColor : minorColor;
      const bridgeSegments = this.roadBridgeFlags?.get(road.id);
      for (let i = 1; i < road.pts.length; i += 1) {
        if (bridgeSegments?.has(i - 1)) continue;
        const [ax, az] = project(road.pts[i - 1][1], road.pts[i - 1][0]);
        const [bx, bz] = project(road.pts[i][1], road.pts[i][0]);
        target.push(ax, 1.0, az, bx, 1.0, bz);
        targetColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
    }
    for (const [positions, colors] of [[minor, minorColors], [major, majorColors]]) {
      if (!positions.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.82 }));
      mesh.renderOrder = 2;
      this.cityRoadGroup.add(mesh);
    }
  }

  _detectRoadBridges() {
    if (this.bridgeCacheCity === this.city && this.bridgeList) {
      this.roadBridgeFlags = this.bridgeFlagsCache;
      return;
    }
    this.roadBridgeFlags = new Map();
    this.bridgeList = [];
    if (!this.city?.water?.length || !this.city?.roads?.length) return;
    const waters = this.city.water
      .map((item) => waterIsLarge(item.poly || []))
      .filter((item) => item.area > 0.00004)
      .sort((a, b) => b.area - a.area);
    if (!waters.length) return;
    const classes = new Set(['motorway', 'trunk', 'primary', 'secondary']);
    for (const road of this.city.roads) {
      if (!classes.has(road.class) || !road.pts || road.pts.length < 4) continue;
      const flags = new Set();
      const runs = [];
      let start = -1;
      for (let i = 0; i < road.pts.length; i += 1) {
        const [lat, lon] = road.pts[i];
        let inWater = false;
        for (const water of waters) {
          if (lat < water.minLat - 0.00015 || lat > water.maxLat + 0.00015 || lon < water.minLon - 0.00015 || lon > water.maxLon + 0.00015) continue;
          if (pointInPoly(lat, lon, water.poly)) { inWater = true; break; }
        }
        if (inWater && start < 0) start = i;
        else if (!inWater && start >= 0) {
          if (i - 1 > start) runs.push([start, i - 1]);
          start = -1;
        }
      }
      if (start >= 0 && road.pts.length - 1 > start) runs.push([start, road.pts.length - 1]);
      for (const [from, to] of runs) {
        const pts = road.pts.slice(from, to + 1);
        let length = 0;
        for (let i = 1; i < pts.length; i += 1) length += metresBetween(pts[i - 1], pts[i]);
        if (length < 80) continue;
        for (let i = from; i < to; i += 1) flags.add(i);
        this.bridgeList.push({ road, pts, length, width: ROAD_WIDTH[road.class] || 10 });
      }
      if (flags.size) this.roadBridgeFlags.set(road.id, flags);
    }
    this.bridgeCacheCity = this.city;
    this.bridgeFlagsCache = this.roadBridgeFlags;
  }

  _buildBridges() {
    if (!this.bridgeList?.length) return;
    const deckMaterial = new THREE.MeshStandardMaterial({ color: 0x8e9296, roughness: 0.76, metalness: 0.2 });
    const railMaterial = new THREE.MeshBasicMaterial({ color: 0xd9c9a5, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    const pierMaterial = new THREE.MeshStandardMaterial({ color: 0x62676c, roughness: 0.9, metalness: 0.08 });
    for (const bridge of this.bridgeList) {
      const deck = ribbon(bridge.pts, bridge.width * 1.45, 12);
      if (deck) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(deck.positions, 3));
        geo.setIndex(deck.indices);
        const mesh = new THREE.Mesh(geo, deckMaterial);
        mesh.renderOrder = 5;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.bridgeGroup.add(mesh);
        const rail = ribbon(bridge.pts, bridge.width * 1.7, 15);
        if (rail) {
          const rgeo = new THREE.BufferGeometry();
          rgeo.setAttribute('position', new THREE.Float32BufferAttribute(rail.positions, 3));
          rgeo.setIndex(rail.indices);
          const rmesh = new THREE.Mesh(rgeo, railMaterial);
          rmesh.renderOrder = 6;
          this.bridgeGroup.add(rmesh);
        }
      }
      const step = Math.max(1, Math.floor(bridge.pts.length / 7));
      for (let i = 1; i < bridge.pts.length - 1; i += step) {
        const [x, z] = project(bridge.pts[i][1], bridge.pts[i][0]);
        const pier = new THREE.Mesh(new THREE.CylinderGeometry(6, 9, 14, 6), pierMaterial);
        pier.position.set(x, 6, z);
        pier.castShadow = true;
        this.bridgeGroup.add(pier);
      }
    }
  }

  _buildCityTrees() {
    if (!this.city?.green?.length) return;
    const points = this.treePointCache || [];
    if (!points.length) {
      const greens = [...this.city.green]
        .filter((item) => item.poly && item.poly.length >= 4)
        .sort((a, b) => (b.poly.length - a.poly.length));
      for (const green of greens) {
        if (points.length >= 1600) break;
        const box = waterIsLarge(green.poly);
        if (box.area < 0.000006) continue;
        const step = Math.max(0.0007, Math.sqrt(box.area / 10));
        for (let lat = box.minLat + step / 2; lat < box.maxLat; lat += step) {
          for (let lon = box.minLon + step / 2; lon < box.maxLon; lon += step) {
            if (points.length >= 1600) break;
            if (!pointInPoly(lat, lon, green.poly)) continue;
            points.push([lon, lat]);
          }
          if (points.length >= 1600) break;
        }
      }
      this.treePointCache = points;
    }
    if (!points.length) return;
    const dummy = new THREE.Object3D();
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(3, 5, 24, 5),
      new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 }),
      points.length,
    );
    const crown = new THREE.InstancedMesh(
      new THREE.ConeGeometry(23, 58, 7),
      new THREE.MeshStandardMaterial({ color: 0x2f5a3c, roughness: 0.92 }),
      points.length,
    );
    const color = new THREE.Color();
    for (let i = 0; i < points.length; i += 1) {
      const [lon, lat] = points[i];
      const [x, z] = project(lon, lat);
      const scale = 0.72 + ((i * 37) % 100) / 170;
      dummy.position.set(x, 12 * scale, z);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.y = (i * 1.7) % (Math.PI * 2);
      dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, 24 * scale + 24 * scale, z);
      dummy.updateMatrix();
      crown.setMatrixAt(i, dummy.matrix);
      color.setHSL(0.29 + ((i * 13) % 40) / 900, 0.34, 0.24 + ((i * 7) % 30) / 220);
      crown.setColorAt(i, color);
    }
    trunk.instanceMatrix.needsUpdate = true;
    crown.instanceMatrix.needsUpdate = true;
    if (crown.instanceColor) crown.instanceColor.needsUpdate = true;
    crown.castShadow = true;
    this.treeGroup.add(trunk, crown);
  }

  _buildCityLights() {
    if (!this.city?.roads?.length) return;
    const street = [];
    const classes = new Set(['motorway', 'trunk', 'primary', 'secondary']);
    for (const road of this.city.roads) {
      if (!classes.has(road.class) || !road.pts || road.pts.length < 4) continue;
      const step = Math.max(2, Math.floor(road.pts.length / 7));
      for (let i = 0; i < road.pts.length; i += step) {
        if (street.length >= 4800) break;
        const [x, z] = project(road.pts[i][1], road.pts[i][0]);
        street.push(x, 24, z);
      }
      if (street.length >= 4800) break;
    }
    if (street.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(street, 3));
      const material = new THREE.PointsMaterial({
        color: 0xffc27a, size: 15, transparent: true, opacity: 0.78,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
      });
      this.cityLightGroup.add(new THREE.Points(geo, material));
    }
    const windows = [];
    for (let i = 0; i < (this.city.buildings || []).length; i += 7) {
      if (windows.length >= 5400) break;
      const building = this.city.buildings[i];
      if (!building.poly || building.poly.length < 3) continue;
      let lon = 0; let lat = 0;
      for (const point of building.poly) { lat += point[0]; lon += point[1]; }
      lon /= building.poly.length;
      lat /= building.poly.length;
      const [x, z] = project(lon, lat);
      const height = Math.max(6, Math.min(160, cityBuildingHeight(building)));
      windows.push(x, height * 0.72 + 4, z);
    }
    if (windows.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(windows, 3));
      const material = new THREE.PointsMaterial({
        color: 0xffe0a8, size: 8, transparent: true, opacity: 0.46,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
      });
      this.cityLightGroup.add(new THREE.Points(geo, material));
    }
  }

  _buildVehicles() {
    this.vehicleData = [];
    if (!this.city?.roads?.length) return;
    const classes = new Set(['motorway', 'trunk', 'primary', 'secondary']);
    let dataCount = 0;
    for (let index = 0; index < this.city.roads.length; index += 1) {
      if (dataCount >= 220) break;
      const road = this.city.roads[index];
      if (!classes.has(road.class) || !road.pts || road.pts.length < 8) continue;
      const pts = road.pts.map(([lat, lon]) => project(lon, lat));
      const cum = [0];
      for (let i = 1; i < pts.length; i += 1) {
        const dx = pts[i][0] - pts[i - 1][0];
        const dz = pts[i][1] - pts[i - 1][1];
        cum.push(cum[i - 1] + Math.hypot(dx, dz));
      }
      const total = cum[cum.length - 1];
      if (total < 400) continue;
      this.vehicleData.push({
        pts, cum, total,
        t: ((index * 0.37) % 1 + 1) % 1,
        speed: 0.000035 + ((index * 17) % 30) / 1000000,
        warm: index % 5 !== 0,
      });
      dataCount += 1;
    }
    if (!this.vehicleData.length) return;
    const positions = new Float32Array(this.vehicleData.length * 3);
    const colors = new Float32Array(this.vehicleData.length * 3);
    const warm = new THREE.Color(0xfff0c2);
    const red = new THREE.Color(0xff5a4a);
    for (let i = 0; i < this.vehicleData.length; i += 1) {
      const item = this.vehicleData[i];
      const [x, z] = item.pts[0];
      positions[i * 3] = x;
      positions[i * 3 + 1] = 18;
      positions[i * 3 + 2] = z;
      const color = item.warm ? warm : red;
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      vertexColors: true, size: 17, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.vehiclePoints = new THREE.Points(geo, material);
    this.vehicleGroup.add(this.vehiclePoints);
  }

  _updateVehicles(delta) {
    if (!this.vehiclePoints || !this.vehicleData?.length) return;
    const attr = this.vehiclePoints.geometry.getAttribute('position');
    for (let i = 0; i < this.vehicleData.length; i += 1) {
      const item = this.vehicleData[i];
      item.t = (item.t + item.speed * Math.min(120, delta)) % 1;
      const target = item.t * item.total;
      let segment = 1;
      while (segment < item.cum.length - 1 && item.cum[segment] < target) segment += 1;
      const span = Math.max(0.001, item.cum[segment] - item.cum[segment - 1]);
      const ratio = Math.min(1, Math.max(0, (target - item.cum[segment - 1]) / span));
      const a = item.pts[segment - 1];
      const b = item.pts[segment];
      attr.setXYZ(i, a[0] + (b[0] - a[0]) * ratio, 18, a[1] + (b[1] - a[1]) * ratio);
    }
    attr.needsUpdate = true;
  }

  _buildHubParking(ids = null) {
    if (!this.city) return;
    clearGroup(this.hubParkingGroup);
    const allow = ids ? new Set(ids) : null;
    const dark = true;
    const positions = [];
    const colors = [];
    const indices = [];
    for (const lot of this.city.parking || []) {
      if (allow && !allow.has(lot.id)) continue;
      if (!lot.poly || lot.poly.length < 3) continue;
      addCityFlat(positions, colors, indices, [lot.poly], dark ? 0x3e7d72 : 0x0f6b62, 2.2);
    }
    if (!positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.58, depthWrite: false,
    }));
    mesh.renderOrder = 4;
    this.hubParkingGroup.add(mesh);
  }

  setParkingFilter(ids = null) {
    this.hubParkingFilter = ids ? ids.slice() : null;
    this._buildHubParking(this.hubParkingFilter);
  }

  setPlaceHandler(handler) {
    this.placeHandler = handler;
  }

  setStationHandler(handler) {
    this.stationHandler = handler;
  }

  setHubHandler(handler) {
    this.hubHandler = handler;
  }

  setRouteHandler(handler) {
    this.routeHandler = handler;
  }

  _placeHitMesh(place, x, z) {
    const hit = new THREE.Mesh(
      new THREE.CylinderGeometry(70, 70, 620, 10),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hit.position.set(x, 310, z);
    hit.userData.place = place;
    this.placeGroup.add(hit);
    this.placePickMeshes.push(hit);
  }

  setHubPoints(points = [], options = {}) {
    if (!this.initialized) return;
    this.hubPoints = points.slice(0, 80);
    this.hubPointOptions = { ...options, focus: false, fit: false };
    clearGroup(this.hubPointGroup);
    this.hubPickMeshes = [];
    for (const point of points.slice(0, 80)) {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
      const color = new THREE.Color(typeof options.color === 'function' ? options.color(point) : (options.color || '#0f6b62'));
      const [x, z] = project(point.lon, point.lat);
      const baseRadius = typeof options.radius === 'function' ? options.radius(point) : (options.radius || 26);
      const radius = Math.max(40, baseRadius) * (point.selected ? 1.45 : 1);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 10, 8),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
      );
      sphere.position.set(x, options.y || 90, z);
      sphere.userData.hub = point;
      this.hubPointGroup.add(sphere);
      this.hubPickMeshes.push(sphere);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius * 1.3, radius * 1.8, 24),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.45 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 2.4, z);
      ring.userData.hub = point;
      this.hubPointGroup.add(ring);
      this.hubPickMeshes.push(ring);
    }
    if (options.fit && points.length) this.fitPoints(points);
    if (options.focus && points[0]) this.focusPoint(points[0].lat, points[0].lon, options.distance || 1800);
  }

  showLocation(lat, lon, label = '我的位置') {
    if (!this.initialized) return;
    clearGroup(this.locationGroup);
    this._removeLabel('my-location');
    const [x, z] = project(lon, lat);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(70, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 }),
    );
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(38, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0x0f6b62 }),
    );
    const group = new THREE.Group();
    group.add(halo, core);
    group.position.set(x, 70, z);
    this.locationGroup.add(group);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(42, 58, 28),
      new THREE.MeshBasicMaterial({ color: 0x0f6b62, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 2, z);
    this.locationGroup.add(ring);
    this._addLabel(label, x, 190, z, 'selected', 'my-location');
    this.focusPoint(lat, lon, 2200);
  }

  clearLocation() {
    if (this.locationGroup) clearGroup(this.locationGroup);
    this._removeLabel('my-location');
  }

  focusPoint(lat, lon, distance = 1500) {
    if (!this.controls) return;
    const [x, z] = project(lon, lat);
    this.controls.target.set(x, 0, z);
    this.camera.position.set(x + distance * 0.3, distance * 0.62, z + distance * 0.72);
    this.controls.update();
  }

  fitPoints(points = []) {
    if (!points.length) return;
    const box = new THREE.Box3();
    for (const point of points) {
      const [x, z] = project(point.lon, point.lat);
      box.expandByPoint(new THREE.Vector3(x, 0, z));
    }
    this.fitBox(box);
  }

  _removeLabel(key) {
    const label = this.labels.find((item) => item.dataset.key === key);
    if (!label) return;
    label.remove();
    this.labels = this.labels.filter((item) => item !== label);
  }

  setBuildings(buildings) {
    if (!this.initialized) return;
    if (this.city) return;
    clearGroup(this.buildingGroup);
    const positions = [];
    const colors = [];
    const indices = [];
    const dark = true;
    const base = new THREE.Color(dark ? 0xa8bac7 : 0x8fa6b8);
    const accent = new THREE.Color(dark ? 0x9c7452 : 0xbfae96);
    // City-scale view needs vertical exaggeration, otherwise 9–30 m buildings vanish at 6 km camera height.
    const VERTICAL_SCALE = 8;
    const heightFor = (building) => {
      let raw;
      if (building.height_m) raw = Math.max(6, Number(building.height_m));
      else if (building.levels) raw = Math.max(6, Number(building.levels) * 3);
      else {
        const type = (building.type || '').toLowerCase();
        if (/apartments|residential|dormitory/.test(type)) raw = 24;
        else if (/office|hotel/.test(type)) raw = 30;
        else if (/commercial|retail/.test(type)) raw = 15;
        else if (/school|university|college|hospital/.test(type)) raw = 16;
        else {
          const name = building.name || '';
          if (/宿/.test(name)) raw = 18;
          else if (/教|学院|实验|图书/.test(name)) raw = 16;
          else if (/食堂|礼堂|体育|活动/.test(name)) raw = 12;
          else raw = 9;
        }
      }
      return raw * VERTICAL_SCALE;
    };
    for (const building of buildings || []) {
      const pts = (building.geometry || []).map(([lon, lat]) => {
        const [x, z] = project(lon, lat);
        return new THREE.Vector2(x, z);
      });
      if (pts.length < 3) continue;
      const height = heightFor(building);
      const color = base.clone().multiplyScalar(0.86 + ((building.id || '').length % 5) * 0.03);
      if (building.name && /滕王阁|八一|车站|机场/.test(building.name)) color.copy(accent);
      const offset = positions.length / 3;
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const quad = [
          [a.x, 0, a.y], [b.x, 0, b.y], [b.x, height, b.y], [a.x, height, a.y],
        ];
        for (const [x, y, z] of quad) { positions.push(x, y, z); colors.push(color.r, color.g, color.b); }
        indices.push(offset + i * 4, offset + i * 4 + 1, offset + i * 4 + 2,
          offset + i * 4, offset + i * 4 + 2, offset + i * 4 + 3);
      }
      const topOffset = positions.length / 3;
      for (const point of pts) { positions.push(point.x, height, point.y); colors.push(color.r, color.g, color.b); }
      for (let i = 1; i < pts.length - 1; i += 1) {
        indices.push(topOffset, topOffset + i, topOffset + i + 1);
      }
    }
    if (!positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color: dark ? 0xc07a5c : 0xb5654a,
      side: THREE.DoubleSide,
    }));
    mesh.renderOrder = 3;
    this.buildingGroup.add(mesh);
  }

  _buildSegments(segments) {
    if (this.segmentMesh) {
      this.scene.remove(this.segmentMesh);
      this.segmentMesh.geometry.dispose();
      this.segmentMesh.material.dispose();
    }
    const positions = [];
    const indices = [];
    const colors = [];
    this.segmentVertexRanges = [];
    this.segmentFaceRanges = [];
    this.columnSegments = [];
    let vertexOffset = 0;
    let faceOffset = 0;
    for (const segment of segments) {
      if (!(segment.zone === 'campus' || segment.zone === 'city')) continue;
      const width = ROAD_WIDTH[segment.highway] || 6;
      const mesh = ribbon(segment.geometry, width, 2);
      if (!mesh) continue;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        positions.push(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
        colors.push(0.18, 0.55, 0.38);
      }
      for (const idx of mesh.indices) indices.push(idx + vertexOffset);
      const vertexCount = mesh.positions.length / 3;
      const triangles = mesh.triangles;
      this.segmentVertexRanges.push({ segment, start: vertexOffset, count: vertexCount });
      this.segmentFaceRanges.push({ segment, start: faceOffset, count: triangles });
      for (let i = 0; i < triangles; i += 1) this.segmentForFace.push(segment);
      vertexOffset += vertexCount;
      faceOffset += triangles;
      this.columnSegments.push(segment);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.segmentMesh = new THREE.Mesh(geo, material);
    this.segmentMesh.renderOrder = 2;
    this.segmentMesh.userData.pickable = true;
    this.scene.add(this.segmentMesh);
  }

  _buildColumns(segments) {
    if (this.columns) {
      this.scene.remove(this.columns);
      this.columns.geometry.dispose();
      this.columns.material.dispose();
    }
    const selected = segments.filter((s) => s.zone === 'campus' || s.zone === 'city');
    this.columnSegments = selected;
    const count = selected.length;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    this.columns = new THREE.InstancedMesh(geo, material, count);
    this.columns.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.columns.frustumCulled = false;
    this.columns.renderOrder = 4;
    this.scene.add(this.columns);
    this._updateColumns();
  }

  _updateColumns() {
    if (!this.columns) return;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const visible = [];
    for (const segment of this.columnSegments) {
      const metric = this.metrics.get(segment.id);
      const pressure = metric ? metric.pressure : 0.4;
      if (segment.zone === 'campus' || pressure >= 0.56) visible.push({ segment, pressure });
    }
    visible.sort((a, b) => b.pressure - a.pressure);
    const limit = Math.min(visible.length, 180);
    this.columns.count = limit;
    for (let i = 0; i < limit; i += 1) {
      const { segment, pressure } = visible[i];
      const [x, z] = project(segment.center[0], segment.center[1]);
      const height = pressure < 0.42 ? 16 : 30 + pressure * 330;
      const width = segment.zone === 'campus' ? 18 : pressure >= 0.85 ? 34 : 24;
      matrix.makeScale(width, Math.max(0.001, height), width);
      matrix.setPosition(x, 0, z);
      this.columns.setMatrixAt(i, matrix);
      color.set(pressureColor(pressure));
      this.columns.setColorAt(i, color);
    }
    this.columns.instanceMatrix.needsUpdate = true;
    if (this.columns.instanceColor) this.columns.instanceColor.needsUpdate = true;
  }

  _startColumnAnim(previousMetrics) {
    if (!this.columns || !this.metrics) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    const visible = [];
    for (const segment of this.columnSegments) {
      const metric = this.metrics.get(segment.id);
      const pressure = metric ? metric.pressure : 0.4;
      if (segment.zone === 'campus' || pressure >= 0.56) visible.push({ segment, pressure });
    }
    visible.sort((a, b) => b.pressure - a.pressure);
    const items = visible.slice(0, 180).map(({ segment, pressure }) => ({
      segment,
      from: previousMetrics?.get(segment.id)?.pressure ?? pressure,
      to: pressure,
    }));
    this.columns.count = items.length;
    this.columnAnim = { start: performance.now(), items };
  }

  _stepColumnAnim(now) {
    if (!this.columnAnim) return;
    const k = Math.min(1, (now - this.columnAnim.start) / 460);
    const eased = 1 - (1 - k) ** 3;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let i = 0; i < this.columnAnim.items.length; i += 1) {
      const item = this.columnAnim.items[i];
      const pressure = item.from + (item.to - item.from) * eased;
      const [x, z] = project(item.segment.center[0], item.segment.center[1]);
      const height = pressure < 0.42 ? 16 : 30 + pressure * 330;
      const width = item.segment.zone === 'campus' ? 18 : pressure >= 0.85 ? 34 : 24;
      matrix.makeScale(width, Math.max(0.001, height), width);
      matrix.setPosition(x, 0, z);
      this.columns.setMatrixAt(i, matrix);
      color.set(pressureColor(pressure));
      this.columns.setColorAt(i, color);
    }
    this.columns.instanceMatrix.needsUpdate = true;
    if (this.columns.instanceColor) this.columns.instanceColor.needsUpdate = true;
    if (k >= 1) this.columnAnim = null;
  }

  updateTraffic(traffic, selectedId = null) {
    const previous = this.metrics;
    this.metrics = traffic.byId || new Map();
    this.selectedId = selectedId;
    const color = new THREE.Color();
    for (const range of this.segmentVertexRanges) {
      const metric = this.metrics.get(range.segment.id);
      const pressure = metric ? metric.pressure : 0.4;
      color.set(pressureColor(pressure));
      const attr = this.segmentMesh.geometry.getAttribute('color');
      for (let i = 0; i < range.count; i += 1) {
        attr.setXYZ(range.start + i, color.r, color.g, color.b);
      }
    }
    this.segmentMesh.geometry.getAttribute('color').needsUpdate = true;
    this._updateColumns();
    this._startColumnAnim(previous);
    this._updateSelection();
    this._syncLabels();
  }

  _updateSelection() {
    if (this.selectionMesh) {
      this.intersectionGroup.remove(this.selectionMesh);
      this.selectionMesh.geometry.dispose();
      this.selectionMesh.material.dispose();
      this.selectionMesh = null;
    }
    if (this.selectionBeam) {
      this.intersectionGroup.remove(this.selectionBeam);
      this.selectionBeam.geometry.dispose();
      this.selectionBeam.material.dispose();
      this.selectionBeam = null;
    }
    if (!this.selectedId) return;
    const segment = (this.network?.segments || []).find((s) => s.id === this.selectedId);
    if (!segment) return;
    const mesh = ribbon(segment.geometry, (ROAD_WIDTH[segment.highway] || 6) + 14, 36);
    if (!mesh) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
    geo.setIndex(mesh.indices);
    const material = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false, depthTest: false });
    this.selectionMesh = new THREE.Mesh(geo, material);
    this.selectionMesh.renderOrder = 10;
    this.intersectionGroup.add(this.selectionMesh);

    const [x, z] = project(segment.center[0], segment.center[1]);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(16, 16, 760, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.42, depthWrite: false, depthTest: false }),
    );
    beam.position.set(x, 380, z);
    beam.renderOrder = 11;
    this.selectionBeam = beam;
    this.intersectionGroup.add(beam);
  }

  setMetro(metro) {
    this.metro = metro || null;
    this._buildMetroLayer();
  }

  _buildMetroLayer() {
    if (!this.initialized) return;
    clearGroup(this.metroGroup);
    this.stationPickMeshes = [];
    const metro = this.metro;
    if (!metro) return;
    const cityRail = this.city?.rail;
    for (const line of metro.lines || []) {
      const groups = [];
      if (cityRail?.length) {
        const keys = line.id === 'L1' ? ['1号线', '地铁1号线', '一号线']
          : line.id === 'L2' ? ['2号线', '地铁2号线', '二号线']
            : line.id === 'L3' ? ['3号线', '地铁3号线', '三号线']
              : ['4号线', '地铁4号线', '四号线'];
        for (const way of cityRail) {
          if (way.railway !== 'subway') continue;
          const text = `${way.name || ''} ${way.ref || ''}`;
          if (!keys.some((key) => text.includes(key))) continue;
          if (way.pts?.length > 1) groups.push(way.pts);
        }
      }
      if (!groups.length) {
        const points = line.stations.map((station) => (station.coord ? [station.coord[1], station.coord[0]] : null)).filter(Boolean);
        if (points.length > 1) groups.push(points);
      }
      for (const raw of groups) {
        const points = raw.map(([lat, lon]) => project(lon, lat)).filter(Boolean);
        if (points.length < 2) continue;
        const positions = [];
        const indices = [];
        const half = 7;
        for (let i = 0; i < points.length; i += 1) {
          const p = points[i];
          const prev = points[Math.max(0, i - 1)];
          const next = points[Math.min(points.length - 1, i + 1)];
          let dx = next[0] - prev[0];
          let dz = next[1] - prev[1];
          const len = Math.hypot(dx, dz) || 1;
          const nx = (-dz / len) * half;
          const nz = (dx / len) * half;
          positions.push(p[0] + nx, 14, p[1] + nz);
          positions.push(p[0] - nx, 14, p[1] - nz);
        }
        for (let i = 0; i < points.length - 1; i += 1) {
          const a = i * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setIndex(indices);
        this.metroGroup.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: line.color, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false,
        })));
      }
      for (const station of line.stations) {
        if (!station.coord) continue;
        const [x, z] = project(station.coord[0], station.coord[1]);
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(16, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.94 }),
        );
        sphere.position.set(x, 20, z);
        sphere.userData.station = { name: station.name, line: line.name, color: line.color, coord: station.coord };
        this.metroGroup.add(sphere);
        this.stationPickMeshes.push(sphere);
      }
    }
  }

  setPlaces(places) {
    if (!this.initialized) return;
    clearGroup(this.placeGroup);
    this.placePickMeshes = [];
    const key = places.filter((p) => ['ecjtu', 'shuanggang', 'bayi', 'west_station', 'airport', 'tengwang', 'qiushui', 'metro_tower'].includes(p.id));
    for (const place of key) {
      const [x, z] = project(place.lon, place.lat);
      this._placeHitMesh(place, x, z);
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(10, 10, 60, 10),
        new THREE.MeshBasicMaterial({ color: 0xc8102e, transparent: true, opacity: 0.85 }),
      );
      pillar.position.set(x, 30, z);
      pillar.userData.place = place;
      this.placeGroup.add(pillar);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(16, 24, 24),
        new THREE.MeshBasicMaterial({ color: 0xc8102e, side: THREE.DoubleSide, transparent: true, opacity: 0.55 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 1, z);
      ring.userData.place = place;
      this.placeGroup.add(ring);
      this._addLandmark(place, x, z);
      this._addLabel(place.name, x, 210, z, 'station');
    }
  }

  _addLandmark(place, x, z) {
    // Landmarks are schematic; vertical scale matches the exaggerated city massing.
    const s = 4;
    const addBox = (w, h, d, y, color, rotation = 0) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h * s, d),
        new THREE.MeshLambertMaterial({ color }),
      );
      mesh.position.set(x, y * s, z);
      mesh.rotation.y = rotation;
      mesh.userData.place = place;
      this.placeGroup.add(mesh);
      return mesh;
    };
    if (place.id === 'tengwang') {
      addBox(55, 18, 55, 9, 0x8b3a2e);
      addBox(46, 16, 46, 26, 0x9b4636);
      addBox(36, 14, 36, 41, 0xad5542);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(42, 18 * s, 4), new THREE.MeshLambertMaterial({ color: 0x6f2d24 }));
      roof.position.set(x, 57 * s, z);
      roof.rotation.y = Math.PI / 4;
      roof.userData.place = place;
      this.placeGroup.add(roof);
    } else if (place.id === 'bayi') {
      addBox(9, 52, 9, 26, 0xc8102e);
      addBox(30, 3, 30, 1.5, 0xb9b1a4);
    } else if (['west_station', 'nanchang_station', 'airport'].includes(place.id)) {
      addBox(190, 26, 70, 13, 0x8d9196);
      addBox(210, 6, 86, 29, 0x6f747a);
    } else if (place.id === 'ecjtu') {
      addBox(110, 14, 9, 7, 0xc8102e);
      addBox(18, 18, 9, 9, 0xc8102e);
    } else if (place.id === 'shuanggang') {
      addBox(58, 10, 28, 5, 0x9b4636);
    } else if (place.id === 'metro_tower') {
      addBox(26, 80, 26, 40, 0x7d858d);
    }
  }

  setRoutes(routes, selectedMode = null, options = {}) {
    if (!this.initialized) return;
    clearGroup(this.routeGroup);
    this.routePickMeshes = [];
    for (const label of [...this.labels]) {
      if (label.dataset.key === 'route-start' || label.dataset.key === 'route-end') {
        label.remove();
        this.labels = this.labels.filter((item) => item !== label);
      }
    }
    for (const route of routes || []) {
      const geometry = route.geometry || route.coords;
      if (!geometry?.length) continue;
      const selected = selectedMode ? route.mode === selectedMode : true;
      const geometryPoints = simplifyRoute(geometry, selected ? 25 : 60);
      if (selected) {
        const casing = ribbon(geometryPoints, 120, 34);
        if (casing) {
          const cgeo = new THREE.BufferGeometry();
          cgeo.setAttribute('position', new THREE.Float32BufferAttribute(casing.positions, 3));
          cgeo.setIndex(casing.indices);
          const cmesh = new THREE.Mesh(cgeo, new THREE.MeshBasicMaterial({
            color: 0xfffdf8, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false,
          }));
          cmesh.renderOrder = 6;
          this.routeGroup.add(cmesh);
        }
      }
      const mesh = ribbon(geometryPoints, selected ? 82 : 30, selected ? 42 : 12);
      if (!mesh) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
      geo.setIndex(mesh.indices);
      const material = new THREE.MeshBasicMaterial({
        color: route.color || MODE_COLORS[route.mode] || '#3b6ea8',
        transparent: true,
        opacity: selected ? 1 : 0.30,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const m = new THREE.Mesh(geo, material);
      m.renderOrder = 7;
      m.userData.route = route;
      this.routePickMeshes.push(m);
      this.routeGroup.add(m);
      if (selected) {
        const start = geometry[0];
        const end = geometry[geometry.length - 1];
        const [sx, sz] = project(start[0], start[1]);
        const [ex, ez] = project(end[0], end[1]);
        const startMarker = new THREE.Mesh(new THREE.SphereGeometry(24, 10, 8), new THREE.MeshBasicMaterial({ color: 0x2f7d5a }));
        startMarker.position.set(sx, 18, sz);
        const endMarker = new THREE.Mesh(new THREE.SphereGeometry(24, 10, 8), new THREE.MeshBasicMaterial({ color: 0xc8102e }));
        endMarker.position.set(ex, 18, ez);
        this.routeGroup.add(startMarker, endMarker);
        this._addLabel(route.fromName || '起点', sx, 150, sz, 'selected', 'route-start');
        this._addLabel(route.toName || '终点', ex, 150, ez, 'selected', 'route-end');
      }
    }
    if (options.fit && routes?.length) {
      const bounds = new THREE.Box3();
      for (const route of routes) {
        for (const [lon, lat] of route.geometry || route.coords || []) {
          const [x, z] = project(lon, lat);
          bounds.expandByPoint(new THREE.Vector3(x, 0, z));
        }
      }
      this.fitBox(bounds);
    }
  }

  setIntersection(intersection) {
    if (!this.initialized) return;
    clearGroup(this.intersectionGroup);
    this.selectionMesh = null;
    this.selectionBeam = null;
    if (!intersection) return;
    const [x, z] = project(intersection.lon, intersection.lat);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(55, 10, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xc8102e }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 12, z);
    this.intersectionGroup.add(ring);
    const marker = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 30, 12), new THREE.MeshBasicMaterial({ color: 0xc8102e }));
    marker.position.set(x, 15, z);
    this.intersectionGroup.add(marker);
    for (const approach of intersection.approaches || []) {
      const rad = (approach.bearing || 0) * Math.PI / 180;
      const distance = 420;
      const dx = Math.sin(rad) * distance;
      const dz = -Math.cos(rad) * distance;
      const color = approach.pressure >= 0.7 ? 0xc8102e : approach.pressure >= 0.45 ? 0xb67800 : 0x2f7d5a;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, 10, z),
        new THREE.Vector3(x + dx, 10, z + dz),
      ]);
      this.intersectionGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color, linewidth: 2 })));
    }
    this._addLabel(intersection.name, x, 90, z, 'selected');
    this.focus(x, z, 2600);
  }

  _addLabel(text, x, y, z, className = '', key = text) {
    const el = document.createElement('div');
    el.className = `scene-label ${className}`;
    el.textContent = text;
    el.dataset.x = x;
    el.dataset.y = y;
    el.dataset.z = z;
    el.dataset.key = key;
    this.labelLayer.appendChild(el);
    this.labels.push(el);
  }

  _syncLabels() {
    if (!this.labelLayer) return;
    const selectedText = this.selectedId
      ? (this.network?.segments || []).find((s) => s.id === this.selectedId)?.name
      : null;
    const existing = this.labels.find((l) => l.dataset.key === '__selected__');
    if (selectedText) {
      if (existing) {
        existing.textContent = selectedText;
      } else {
        const segment = this.network.segments.find((s) => s.id === this.selectedId);
        if (segment) {
          const [x, z] = project(segment.center[0], segment.center[1]);
          const el = document.createElement('div');
          el.className = 'scene-label selected';
          el.textContent = selectedText;
          el.dataset.x = x;
          el.dataset.y = 900;
          el.dataset.z = z;
          el.dataset.key = '__selected__';
          this.labelLayer.appendChild(el);
          this.labels.push(el);
        }
      }
    } else if (existing) {
      existing.remove();
      this.labels = this.labels.filter((l) => l !== existing);
    }
  }

  pulseAt(lat, lon, color = '#ffd166') {
    if (!this.pulseGroup) return;
    const [x, z] = project(lon, lat);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(26, 38, 40),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color), side: THREE.DoubleSide, transparent: true, opacity: 0.92, depthWrite: false, depthTest: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 8, z);
    ring.renderOrder = 20;
    this.pulseGroup.add(ring);
    this.pulses.push({ mesh: ring, start: performance.now() });
  }

  _updatePulses(now) {
    for (let i = this.pulses.length - 1; i >= 0; i -= 1) {
      const pulse = this.pulses[i];
      const k = (now - pulse.start) / 820;
      if (k >= 1) {
        this.pulseGroup.remove(pulse.mesh);
        pulse.mesh.geometry.dispose();
        pulse.mesh.material.dispose();
        this.pulses.splice(i, 1);
        continue;
      }
      const scale = 1 + k * 3.4;
      pulse.mesh.scale.set(scale, scale, scale);
      pulse.mesh.material.opacity = 0.92 * (1 - k);
    }
  }

  _pickAt(event) {
    if (!this.camera) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const objects = [
      ...this.placePickMeshes,
      ...this.stationPickMeshes,
      ...this.hubPickMeshes,
      ...this.routePickMeshes,
      this.segmentMesh,
    ].filter(Boolean);
    if (!objects.length) return null;
    const hits = this.raycaster.intersectObjects(objects, false);
    return hits[0] || null;
  }

  _describeHit(hit) {
    if (!hit?.object) return null;
    const data = hit.object.userData || {};
    if (data.place) {
      const place = data.place;
      return {
        type: 'place',
        key: `place:${place.id}`,
        lat: place.lat,
        lon: place.lon,
        title: place.name,
        sub: place.kind || '地点',
        color: '#ffd166',
        data: place,
      };
    }
    if (data.station) {
      const { name, line, coord } = data.station;
      return {
        type: 'station',
        key: `station:${name}`,
        lat: coord?.[1],
        lon: coord?.[0],
        title: name,
        sub: `${line} · 地铁站`,
        color: data.station.color || '#3b6ea8',
        data: data.station,
      };
    }
    if (data.hub) {
      const point = data.hub;
      return {
        type: 'hub',
        key: `hub:${point.id || point.name}`,
        lat: point.lat,
        lon: point.lon,
        title: point.name || '任务点',
        sub: point.kind || '地图要素',
        color: '#2f7d5a',
        data: point,
      };
    }
    if (data.route) {
      const route = data.route;
      return {
        type: 'route',
        key: `route:${route.id || route.mode}`,
        title: route.label || route.mode || '路线',
        sub: `${(route.distance_km || 0).toFixed(2)} km`,
        color: route.color || '#3b6ea8',
        data: route,
      };
    }
    if (hit.object === this.segmentMesh && Number.isInteger(hit.faceIndex)) {
      const segment = this.segmentForFace[hit.faceIndex];
      if (!segment) return null;
      const metric = this.metrics.get(segment.id);
      return {
        type: 'segment',
        key: `segment:${segment.id}`,
        lat: segment.center[1],
        lon: segment.center[0],
        title: segment.name,
        sub: metric ? `压力 ${(metric.pressure * 100).toFixed(0)}/100 · ${metric.speed.toFixed(0)} km/h` : '未计算',
        color: metric ? pressureColor(metric.pressure) : '#ffd166',
        data: segment,
      };
    }
    return null;
  }

  _clearHoverVisual() {
    if (this.hoverRing) {
      this.intersectionGroup.remove(this.hoverRing);
      this.hoverRing.geometry.dispose();
      this.hoverRing.material.dispose();
      this.hoverRing = null;
    }
    if (this.hoverMesh) {
      this.intersectionGroup.remove(this.hoverMesh);
      this.hoverMesh.geometry.dispose();
      this.hoverMesh.material.dispose();
      this.hoverMesh = null;
    }
    this.hoverTarget = null;
  }

  _clearHover() {
    this._clearHoverVisual();
    if (this._hoverTip) this._hoverTip.hidden = true;
    if (this.renderer) this.renderer.domElement.style.cursor = '';
  }

  _showTip(event, info) {
    if (!this._hoverTip) return;
    const rect = this.container.getBoundingClientRect();
    const x = Math.min(rect.width - 190, Math.max(8, event.clientX - rect.left + 16));
    const y = Math.min(rect.height - 60, Math.max(8, event.clientY - rect.top + 14));
    this._hoverTip.style.left = `${x}px`;
    this._hoverTip.style.top = `${y}px`;
    this._hoverTip.innerHTML = `<b>${escapeHtml(info.title)}</b><span>${escapeHtml(info.sub)}</span>`;
    this._hoverTip.hidden = false;
    this._hoverTip.style.setProperty('--tip-color', info.color || '#ffd166');
  }

  _onPointerDown(event) {
    this._pointerDown = { x: event.clientX, y: event.clientY };
  }

  _onPointerLeave() {
    this._clearHover();
  }

  _onPointerMove(event) {
    if (!this.initialized || !this.renderer) return;
    const now = performance.now();
    if (now - this._lastHover < 40) return;
    this._lastHover = now;
    const hit = this._pickAt(event);
    const info = this._describeHit(hit);
    if (!info) {
      this._clearHover();
      return;
    }
    this.renderer.domElement.style.cursor = 'pointer';
    this._showTip(event, info);
    if (this.hoverTarget === info.key) return;
    this._clearHoverVisual();
    this.hoverTarget = info.key;
    if (info.type === 'segment') {
      const mesh = ribbon(info.data.geometry, (ROAD_WIDTH[info.data.highway] || 6) + 18, 30);
      if (mesh) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
        geo.setIndex(mesh.indices);
        this.hoverMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: 0xffd166, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, depthTest: false,
        }));
        this.hoverMesh.renderOrder = 12;
        this.intersectionGroup.add(this.hoverMesh);
      }
    } else if (Number.isFinite(info.lat) && Number.isFinite(info.lon)) {
      const [x, z] = project(info.lon, info.lat);
      this.hoverRing = new THREE.Mesh(
        new THREE.RingGeometry(54, 74, 36),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(info.color || '#ffd166'), side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false }),
      );
      this.hoverRing.rotation.x = -Math.PI / 2;
      this.hoverRing.position.set(x, 6, z);
      this.hoverRing.renderOrder = 13;
      this.intersectionGroup.add(this.hoverRing);
    }
  }

  _onClick(event) {
    if (this._pointerDown) {
      const moved = Math.hypot(event.clientX - this._pointerDown.x, event.clientY - this._pointerDown.y);
      this._pointerDown = null;
      if (moved > 6) return;
    }
    const hit = this._pickAt(event);
    const info = this._describeHit(hit);
    if (!info) {
      this.onSelect(null);
      return;
    }
    if (Number.isFinite(info.lat) && Number.isFinite(info.lon)) this.pulseAt(info.lat, info.lon, info.color);
    if (info.type === 'place') (this.placeHandler || this.onPlace)?.(info.data);
    else if (info.type === 'station') (this.stationHandler || this.onStation)?.(info.data.name, { name: info.data.line, color: info.data.color });
    else if (info.type === 'hub') {
      const handler = this.hubHandler || this.onHub || this.hubPointOptions?.onSelect;
      handler?.(info.data);
    }
    else if (info.type === 'route') (this.routeHandler || this.onRoute)?.(info.data);
    else if (info.type === 'segment') this.onSelect(info.data.id);
  }

  focusSegment(segment) {
    if (!this.controls || !segment?.center) return;
    const [x, z] = project(segment.center[0], segment.center[1]);
    this.controls.target.set(x, 0, z);
    this.camera.position.set(x + 900, 1500, z + 1900);
    this.controls.update();
  }

  focus(x, z, distance = 2600) {
    const target = new THREE.Vector3(x, 0, z);
    this.controls.target.copy(target);
    this.camera.position.set(x + distance * 0.35, distance * 0.62, z + distance * 0.72);
    this.controls.update();
  }

  fitBox(box) {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const distance = Math.max(1200, Math.max(size.x, size.z) * 1.22);
    this.controls.target.set(center.x, 0, center.z);
    this.camera.position.set(center.x + distance * 0.20, distance * 0.50, center.z + distance * 0.66);
    this.controls.update();
  }

  resetView() {
    if (!this.controls) return;
    if (this.city?.meta?.center) {
      const [x, z] = project(this.city.meta.center[1], this.city.meta.center[0]);
      this.controls.target.set(x, 0, z);
      this.camera.position.set(x + 2400, 4600, z + 6200);
      this.controls.update();
      return;
    }
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, 2600, 3800);
    this.controls.update();
  }

  startTrip(legs) {
    if (!this.initialized || !this.tripGroup) return;
    this.clearTrip();
    if (!legs?.length) return;
    this.tripLegs = legs;
    const box = new THREE.Box3();
    for (const leg of legs) {
      if (!leg.geometry || leg.geometry.length < 2) continue;
      const pts = leg.geometry.map(([lon, lat]) => {
        const [x, z] = project(lon, lat);
        box.expandByPoint(new THREE.Vector3(x, 0, z));
        return new THREE.Vector3(x, 34, z);
      });
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.min(600, Math.max(24, pts.length * 2)), 10, 4, false),
        new THREE.MeshBasicMaterial({ color: leg.color, transparent: true, opacity: 0.3 }),
      );
      this.tripGroup.add(tube);
    }
    const first = legs.find((leg) => leg.geometry?.length)?.geometry[0];
    if (first) {
      const [x, z] = project(first[0], first[1]);
      const group = new THREE.Group();
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(92, 14, 10),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
      );
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(54, 16, 12),
        new THREE.MeshBasicMaterial({ color: legs[0].color || 0xc8102e }),
      );
      group.add(halo, core);
      group.position.set(x, 90, z);
      this.tripMarker = group;
      this.tripMarkerCore = core;
      this.tripGroup.add(group);
    }
    if (!box.isEmpty()) this.fitBox(box);
    this._tripLegIndex = -1;
  }

  updateTrip(state) {
    if (!this.tripMarker || !state) return;
    const [x, z] = project(state.lon, state.lat);
    const previous = this.tripMarker.position.clone();
    this.tripMarker.position.set(x, 90, z);
    if (this.tripMarkerCore) this.tripMarkerCore.material.color.set(state.color || '#c8102e');
    if (state.legIndex !== this._tripLegIndex) {
      this._tripLegIndex = state.legIndex;
      const old = this.tripGroup.children.filter((child) => child.userData.activeLeg);
      for (const child of old) {
        this.tripGroup.remove(child);
        child.geometry?.dispose();
        child.material?.dispose();
      }
      const leg = this.tripLegs[state.legIndex] || state.leg;
      if (leg?.geometry?.length > 1) {
        const pts = leg.geometry.map(([lon, lat]) => {
          const [lx, lz] = project(lon, lat);
          return new THREE.Vector3(lx, 36, lz);
        });
        const curve = new THREE.CatmullRomCurve3(pts);
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(curve, Math.min(700, Math.max(24, pts.length * 2)), 26, 5, false),
          new THREE.MeshBasicMaterial({ color: state.color || leg.color }),
        );
        tube.userData.activeLeg = true;
        this.tripGroup.add(tube);
      }
    }
    if (this.tripFollow && this.controls) {
      const dx = x - previous.x;
      const dz = z - previous.z;
      this.controls.target.set(x, 0, z);
      this.camera.position.x += dx;
      this.camera.position.z += dz;
      this.controls.update();
    }
  }

  setTripFollow(follow) {
    this.tripFollow = !!follow;
  }

  clearTrip() {
    if (this.tripGroup) clearGroup(this.tripGroup);
    this.tripMarker = null;
    this.tripMarkerCore = null;
    this.tripLegs = [];
    this._tripLegIndex = -1;
  }

  applyTheme() {
    if (!this.scene) return;
    this.scene.background = this._skyTexture();
    if (this.scene.fog) this.scene.fog.color.set(0x121b24);
    this._applyGroundTexture(this.base);
    if (this.city) this.setCity(this.city);
    this._syncLabels();
  }

  _resize() {
    if (!this.renderer) return;
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 520;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this._loop);
  }

  stop() {
    this.running = false;
  }

  _loop() {
    if (!this.running) return;
    requestAnimationFrame(this._loop);
    if (document.hidden) return;
    const now = performance.now();
    const delta = now - this.lastFrame;
    this.lastFrame = now;
    this.fpsAccum += delta;
    this.fpsFrames += 1;
    if (this.fpsAccum >= 1000) {
      this.fps = Math.round(this.fpsFrames * 1000 / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    this.controls.update();
    this._updateVehicles(delta);
    this._updatePulses(now);
    this._stepColumnAnim(now);
    this.renderer.render(this.scene, this.camera);
    this._positionLabels();
  }

  _positionLabels() {
    if (!this.labelLayer) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const rects = [];
    const vector = new THREE.Vector3();
    const priority = (el) => {
      const key = el.dataset.key || '';
      if (key === 'route-start' || key === 'route-end') return 3;
      if (el.classList.contains('selected')) return 2;
      return 1;
    };
    const ordered = [...this.labels].sort((a, b) => priority(b) - priority(a));
    for (const label of ordered) {
      const x = Number(label.dataset.x);
      const y = Number(label.dataset.y);
      const z = Number(label.dataset.z);
      vector.set(x, y, z).project(this.camera);
      const visible = vector.z > -1 && vector.z < 1 && Math.abs(vector.x) < 1.12 && Math.abs(vector.y) < 1.12;
      if (!visible) {
        label.classList.add('hidden');
        continue;
      }
      const px = (vector.x * 0.5 + 0.5) * width;
      const py = (-vector.y * 0.5 + 0.5) * height;
      const w = label.offsetWidth || 70;
      const h = label.offsetHeight || 18;
      const rect = { left: px - w / 2, top: py - h / 2, right: px + w / 2, bottom: py + h / 2 };
      const overlap = rects.some((r) => !(rect.right < r.left + 3 || rect.left > r.right - 3 || rect.bottom < r.top + 2 || rect.top > r.bottom - 2));
      if (overlap && !label.classList.contains('selected')) {
        label.classList.add('hidden');
        continue;
      }
      label.classList.remove('hidden');
      label.style.left = `${px}px`;
      label.style.top = `${py}px`;
      rects.push(rect);
    }
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._resize);
    this.resizeObserver?.disconnect();
    this.renderer?.domElement?.removeEventListener('click', this._onClick);
    this.renderer?.domElement?.removeEventListener('pointermove', this._onPointerMove);
    this.renderer?.domElement?.removeEventListener('pointerdown', this._onPointerDown);
    this.renderer?.domElement?.removeEventListener('pointerleave', this._onPointerLeave);
    this._hoverTip?.remove();
    this._hoverTip = null;
    this.controls?.dispose?.();
    this.labelLayer?.remove();
    if (this.scene) {
      this.scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
          else object.material.dispose();
        }
      });
    }
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.labelLayer = null;
    this.initialized = false;
  }
}
