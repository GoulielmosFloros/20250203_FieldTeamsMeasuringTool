import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as BUI from "@thatopen/ui";
import * as FRAGS from "@thatopen/fragments";
import projectInformation from "./components/Panels/ProjectInformation";
import elementData from "./components/Panels/Selection";
import settings from "./components/Panels/Settings";
import load from "./components/Toolbars/Sections/Import";
import help from "./components/Panels/Help";
import camera from "./components/Toolbars/Sections/Camera";
import measurement from "./components/Toolbars/Sections/Measurement";
import selection from "./components/Toolbars/Sections/Selection";
import { AppManager, OpeningMeasurement } from "./bim-components";

BUI.Manager.init();

const components = new OBC.Components();
const worlds = components.get(OBC.Worlds);

const world = worlds.create<
  OBC.SimpleScene,
  OBC.OrthoPerspectiveCamera,
  OBF.PostproductionRenderer
>();
world.name = "Main";

world.scene = new OBC.SimpleScene(components);
world.scene.setup();
world.scene.three.background = null;

const viewport = BUI.Component.create<BUI.Viewport>(() => {
  return BUI.html`
    <bim-viewport>
      <bim-grid floating></bim-grid>
    </bim-viewport>
  `;
});

world.renderer = new OBF.PostproductionRenderer(components, viewport);
const { postproduction } = world.renderer;

world.camera = new OBC.OrthoPerspectiveCamera(components);

const worldGrid = components.get(OBC.Grids).create(world);
worldGrid.material.uniforms.uColor.value = new THREE.Color(0x424242);
worldGrid.material.uniforms.uSize1.value = 2;
worldGrid.material.uniforms.uSize2.value = 8;

const resizeWorld = () => {
  world.renderer?.resize();
  world.camera.updateAspect();
};

viewport.addEventListener("resize", resizeWorld);

components.init();

postproduction.enabled = true;
postproduction.customEffects.excludedMeshes.push(worldGrid.three);
postproduction.setPasses({ custom: true, ao: true, gamma: true });
postproduction.customEffects.lineColor = 0x17191c;

const appManager = components.get(AppManager);
const viewportGrid = viewport.querySelector<BUI.Grid>("bim-grid[floating]")!;
appManager.grids.set("viewport", viewportGrid);

const fragments = components.get(OBC.FragmentsManager);
const indexer = components.get(OBC.IfcRelationsIndexer);
const classifier = components.get(OBC.Classifier);
classifier.list.CustomSelections = {};

const ifcLoader = components.get(OBC.IfcLoader);
await ifcLoader.setup();

const tilesLoader = components.get(OBF.IfcStreamer);
tilesLoader.world = world;
tilesLoader.culler.threshold = 10;
tilesLoader.culler.maxHiddenTime = 1000;
tilesLoader.culler.maxLostTime = 40000;

const highlighter = components.get(OBF.Highlighter);
highlighter.setup({ world });
highlighter.zoomToSelection = true;

const culler = components.get(OBC.Cullers).create(world);
culler.threshold = 5;

world.camera.controls.restThreshold = 0.25;
world.camera.controls.addEventListener("rest", () => {
  culler.needsUpdate = true;
  tilesLoader.cancel = true;
  tilesLoader.culler.needsUpdate = true;
});

fragments.onFragmentsLoaded.add(async (model) => {
  if (model.hasProperties) {
    await indexer.process(model);
    classifier.byEntity(model);
  }

  if (!model.isStreamed) {
    for (const fragment of model.items) {
      world.meshes.add(fragment.mesh);
      culler.add(fragment.mesh);
    }
  }

  world.scene.three.add(model);

  if (!model.isStreamed) {
    setTimeout(async () => {
      world.camera.fit(world.meshes, 0.8);
    }, 50);
  }
});

fragments.onFragmentsDisposed.add(({ fragmentIDs }) => {
  for (const fragmentID of fragmentIDs) {
    const mesh = [...world.meshes].find((mesh) => mesh.uuid === fragmentID);
    if (mesh) {
      world.meshes.delete(mesh);
    }
  }
});

const projectInformationPanel = projectInformation(components);
const elementDataPanel = elementData(components);

// We retrieve the opening measurement component.
// This component is responsible for creating the opening measurements.
const openingMeasurement = components.get(OpeningMeasurement);

// We set the world to the opening measurement component,
// so it can properly display the preview geometry within the scene.
openingMeasurement.world = world;

openingMeasurement.enabled = true;

// We obtain the raycaster associated with the current world.
// The raycaster will be used to detect the objects we are hovering and clicking on.
const raycaster = components.get(OBC.Raycasters).get(world);

// We listen to the mousemove event to perform real-time calculations
// based on the mouse position. This is where the preview is updated.
window.addEventListener("mousemove", () => {
  // We cast a ray from the mouse position into the scene, to see if we're
  // hovering over any object.
  const result = raycaster.castRay();
  if (!result) {
    // If we don't hit anything, we reset the opening measurement
    // because we're not focusing on an element, which avoids leaving
    // the preview geometry in an invalid state.
    openingMeasurement.reset();
    return;
  }

  // If we hit something, we extract the data of the raycast result.
  const { object, instanceId, faceIndex, point: hitPoint } = result;

  // We validate if we are actually hitting a FragmentMesh
  // to avoid errors when the raycast is hitting other kinds of objects
  // as the logic to get the face edges depends on the object to be
  // a FragmentMesh
  if (
    !(
      instanceId !== undefined &&
      faceIndex !== undefined &&
      object instanceof FRAGS.FragmentMesh
    )
  ) {
    // If not, we reset the component because is not the correct object.
    openingMeasurement.reset();
    return;
  }

  // If all is correct, we get the measurement utility component because
  // we need to obtain the face data from the raycast result.
  const measurement = components.get(OBC.MeasurementUtils);
  const face = measurement.getFace(object, faceIndex, instanceId);
  // If we can't obtain the face data, we exit because we can't perform the measurement
  if (!face) return;

  // If we have face data, we map to get the points of all edges.
  // The reason for this is because the `OpeningMeasurement` needs
  // all the possible edges to extract the vertices and take the farthest
  // from each endpoint.
  const edges = face.edges.map((edge) => edge.points);
  openingMeasurement.edges = edges;

  // We find the closest edge to the mouse position.
  // This is the line where we will be measuring the opening.
  const closestEdge = edges.reduce((prev, curr) => {
    // We unpack the points of the previous edge
    const [pv1, pv2] = prev;
    // We calculate the distance from the hit point (mouse position) to
    // the previous edge using a utility function.
    const previousDistance = OBC.MeasurementUtils.distanceFromPointToLine(
      hitPoint,
      pv1,
      pv2,
      true,
    );

    // We unpack the points of the current edge.
    const [cv1, cv2] = curr;

    // We calculate the distance from the hit point (mouse position) to
    // the current edge using a utility function.
    const currentDistance = OBC.MeasurementUtils.distanceFromPointToLine(
      hitPoint,
      cv1,
      cv2,
      true,
    );

    // We compare the current distance with the previous distance,
    // and we also check if the distance is less than 0.3, so
    // the user needs to be close to the edge to actually select it.
    if (currentDistance < 0.3 && currentDistance < previousDistance) {
      // If the current edge is closer we return it.
      return curr;
    }
    // Otherwise, we keep the previous edge.
    return prev;
  });

  // Finally, we create a new line3 with the selected edge.
  openingMeasurement.edge = new THREE.Line3(closestEdge[0], closestEdge[1]);
});

window.addEventListener("click", () => {
  // When the user clicks, we perform the final opening measurement.
  openingMeasurement.measure();
});

const toolbar = BUI.Component.create(() => {
  return BUI.html`
    <bim-tabs floating style="justify-self: center; border-radius: 0.5rem;">
      <bim-tab label="Import">
        <bim-toolbar>
          ${load(components)}
        </bim-toolbar>
      </bim-tab>
      <bim-tab label="Selection">
        <bim-toolbar>
          ${camera(world)}
          ${selection(components, world)}
        </bim-toolbar>
      </bim-tab>
      <bim-tab label="Measurement">
        <bim-toolbar>
            ${measurement(world, components)}
        </bim-toolbar>      
      </bim-tab>
    </bim-tabs>
  `;
});

const leftPanel = BUI.Component.create(() => {
  return BUI.html`
    <bim-tabs switchers-full>
      <bim-tab name="project" label="Project" icon="ph:building-fill">
        ${projectInformationPanel}
      </bim-tab>
      <bim-tab name="settings" label="Settings" icon="solar:settings-bold">
        ${settings(components)}
      </bim-tab>
      <bim-tab name="help" label="Help" icon="material-symbols:help">
        ${help}
      </bim-tab>
    </bim-tabs> 
  `;
});

const app = document.getElementById("app") as BUI.Grid;
app.layouts = {
  main: {
    template: `
      "leftPanel viewport" 1fr
      /26rem 1fr
    `,
    elements: {
      leftPanel,
      viewport,
    },
  },
};

app.layout = "main";

viewportGrid.layouts = {
  main: {
    template: `
      "empty" 1fr
      "toolbar" auto
      /1fr
    `,
    elements: { toolbar },
  },
  second: {
    template: `
      "empty elementDataPanel" 1fr
      "toolbar elementDataPanel" auto
      /1fr 24rem
    `,
    elements: {
      toolbar,
      elementDataPanel,
    },
  },
};

viewportGrid.layout = "main";
