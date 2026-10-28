// Canonical Bob home coordinates. Geometry and safety bounds remain in house_bounds.js.
export const HOME = Object.freeze({
    base: Object.freeze({x:-823,y:124,z:568}),
    door: Object.freeze({x:-820,y:124,z:566}),
    entrance: Object.freeze({x:-819.5,y:124,z:565.5}),
    inside: Object.freeze({x:-819.5,y:124,z:567.5}),
    bed: Object.freeze({x:-822,y:124,z:569}),
    exitWaypoint: Object.freeze({x:-819.5,y:124,z:562.5}),
    seedRoute: Object.freeze([[-819.5,123,553.5],[-819.5,123,559.5],[-819.5,123,562.5],[-819.5,124,565.5]].map(p => Object.freeze(p))),
    plateSupport: Object.freeze({x:-820,y:123,z:565}),
    // Physical geometry of the current house. New homes may have different dimensions.
    geometry: Object.freeze({
        area: Object.freeze({x1:-827,x2:-816,y1:123,y2:127,z1:566,z2:573}),
        porch: Object.freeze({x1:-827,x2:-816,y1:123,y2:127,z1:564,z2:565}),
        walkingLane: Object.freeze({x1:-821,x2:-819,y1:123,y2:126,z1:564,z2:565})
    })
});
