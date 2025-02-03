import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as THREE from "three";

export class OpeningMeasurement extends OBC.Component {
  static uuid = "11a42ddf-a099-485f-a913-2134cfc259bd" as const;
  enabled = true;

  // We need to keep track of the world because the preview geometry
  // needs to be added to the scene to be displayed, and when the world is
  // removed, the preview must be removed too, so it doesnt leak memory or
  // causes visual bugs.
  private _world: OBC.World | null = null;
  set world(value: OBC.World | null) {
    this._world = value;
    // When the world is set, we add the edge preview to the scene.
    // This is the graphical representation of the edge took for the measurement.
    if (value) {
      value.scene.three.add(this._edgePreview);
    } else {
      // If no world is provided, it means the component is not longer used
      // so we remove the preview from the parent so it is properly cleaned up.
      this._edgePreview.removeFromParent();
    }
  }

  get world() {
    return this._world;
  }

  // We need to store the edge because this is the base line for the measurement.
  // It will define the two of the four endpoints for the measurement.
  private _edge: THREE.Line3 | null = null;

  set edge(value: THREE.Line3 | null) {
    this._edge = value;
    // We make the preview visible if an edge was set.
    this._edgePreview.visible = !!value;
    if (!value) return;
    // If we have a new edge, we update the preview geometry with the
    // start and end of the line.
    const previewGeometry = this._edgePreview.geometry;
    previewGeometry.setFromPoints([value.start, value.end]);
    previewGeometry.attributes.position.needsUpdate = true;
    previewGeometry.computeBoundingBox();
    previewGeometry.computeBoundingSphere();
    // Those two last operations are performed because this is a "dynamic" object
    // that updates its vertices and thus we need to tell threejs to recalculate
    // the geometry bounds to not have culling problems.
  }

  get edge() {
    return this._edge;
  }

  // We create a preview of the edge to be measured, so the user can see
  // what's being measured.
  private _edgePreview = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: "red",
      depthTest: false,
    }),
  );

  constructor(components: OBC.Components) {
    super(components);
    components.add(OpeningMeasurement.uuid, this);
    // We add this component to the components manager, so we can retrieve it later.
  }

  // This will be a 2D array of points because we are processing edges
  // and each edge has two points. Those points will be used to calculate
  // the size of the opening.
  edges: THREE.Vector3[][] = [];

  measure() {
    // We cannot perform a measurement without an edge so we return the function.
    if (!this.edge) return;
    const edge = this.edge;
    // We need to know the direction of the edge because the algorithm
    // calculates the projection points that are perpendicular to the edge
    const edgeDirection = new THREE.Vector3();
    edge.delta(edgeDirection);
    edgeDirection.normalize();

    // We use flat here because we have a 2D array and we need to iterate
    // over a 1D array of points, so we get a collection with all
    // the vertices from the element face.
    const vertices = this.edges.flat();

    // We need the farthest point from the start of the edge.
    // This point indicates the "depth" of the measurement.
    // For example, if it's a door, this will be the door frame depth.
    const farthestFromStart = vertices.reduce((prev, curr) => {
      const currLine = new THREE.Line3(edge.start, curr);
      const currLineDir = new THREE.Vector3();
      currLine.delta(currLineDir);
      // We only consider points that are in the oposite direction
      // of the edge start. See the video for a deeper explanation
      // on this.
      if (currLineDir.dot(edgeDirection) >= 0) return prev;

      const prevLine = new THREE.Line3(edge.start, prev);
      // Here we compare the distance and return the farthest one.
      if (currLine.distance() > prevLine.distance()) return curr;
      return prev;
    }, edge.start);

    // Same logic as above but getting the farthest point from the end of the edge.
    const farthestFromEnd = vertices.reduce((prev, curr) => {
      const currLine = new THREE.Line3(edge.end, curr);
      const currLineDir = new THREE.Vector3();
      currLine.delta(currLineDir);
      // We only consider points that are in the oposite direction
      // of the edge end.
      if (currLineDir.dot(edgeDirection) <= 0) return prev;

      const prevLine = new THREE.Line3(edge.end, prev);
      if (currLine.distance() > prevLine.distance()) return curr;
      return prev;
    }, edge.end);

    // We get the length measurement component to create the visual representation of the
    // measurement.
    const lengthMeasurement = this.components.get(OBF.LengthMeasurement);

    // If the farthest point from the start is not the same as the start point,
    // it means we have a point to create a measurement, so we project the
    // farthest point to the edge.
    if (!edge.start.equals(farthestFromStart)) {
      const projection = new THREE.Vector3();
      edge.closestPointToPoint(farthestFromStart, false, projection);
      const line = new THREE.Line3(edge.start, projection);
      // We check the distance because sometimes the point could be the same
      // and then we won't need to create a visual representation of the line.
      if (line.distance() > 0) {
        lengthMeasurement.createOnPoints(edge.start, projection);
      }
    }

    // Same logic as above but for the end point of the edge.
    if (!edge.end.equals(farthestFromEnd)) {
      const projection = new THREE.Vector3();
      edge.closestPointToPoint(farthestFromEnd, false, projection);
      const line = new THREE.Line3(edge.end, projection);
      if (line.distance() > 0) {
        lengthMeasurement.createOnPoints(edge.end, projection);
      }
    }
  }

  reset() {
    // We reset the edges and the edge to start a new measurement.
    this.edges = [];
    this.edge = null;
  }
}
