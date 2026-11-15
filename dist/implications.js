// Plain-language consequences of a rising or falling trend in each layer.
// These describe what this kind of change generally brings; they are not
// measurements for the selected cell.
const heat = {
  land: {
    up: ['More and longer heat waves, with more heat stress for people who work or live without cooling.',
      'Longer growing seasons, but also longer wildfire seasons and faster drying of soils.',
      'In cold regions, less snow cover and thawing permafrost that damages roads and buildings.'],
    down: ['Fewer hot extremes and a shorter growing season.',
      'More frost risk for crops at the start and end of the season.',
      'A local cooling usually comes from changes in cloud, haze or nearby ocean currents, not a reversal of global warming.'],
  },
  sea: {
    up: ['Warmer air over the sea follows a warming ocean and carries more moisture into storms.',
      'At high latitudes, a shorter sea ice season and more open water.',
      'Coasts downwind get milder winters and more humid summers.'],
    down: ['Cooler air over the sea, often from stronger winds or colder water rising from below.',
      'Less moisture available to nearby storms.',
      'A local cooling like this does not mean global warming has stopped.'],
  },
};

const LAYERS = {
  temperature: heat, air: heat, skin: heat,
  sst: {
    up: ['Marine heat waves that stress fish, kelp and shellfish, and bleach corals in tropical waters.',
      'Warmer water takes up more room, which adds to sea level rise.',
      'More energy and moisture for tropical storms and heavy coastal rain.'],
    down: ['Often a sign of stronger upwelling or a shift in currents rather than less heat in the ocean overall.',
      'Colder, nutrient-rich water can boost fisheries locally.',
      'Cooler water gives nearby storms less energy.'],
  },
  precipitation: {
    up: ['Higher flood risk, especially when the extra rain arrives in heavy downpours.',
      'More erosion, landslides and strain on storm drains.',
      'More water for rivers, reservoirs and crops if it falls steadily.'],
    down: ['More frequent and longer droughts.',
      'Lower rivers, reservoirs and groundwater, with tighter water supply for cities and farms.',
      'Drier vegetation and a higher wildfire risk.'],
  },
  moisture: {
    up: ['Heavier downpours, because air holds about 7% more water vapor for each degree Celsius it warms.',
      'Muggier heat, which is harder on the body because sweat evaporates less.',
      'Water vapor traps heat, so more of it strengthens warming.'],
    down: ['Drier air pulls more water out of soils and plants.',
      'More days of fire weather.',
      'Less moisture available for rain.'],
  },
  pressure: {
    up: ['More settled, clear weather with less rain.',
      'Persistent high pressure can lock in droughts and heat waves.',
      'Storm tracks tend to shift away from the area.'],
    down: ['More unsettled weather as storm tracks move closer.',
      'More cloud, rain and wind.',
      'Lower pressure lets storm surges ride higher along coasts.'],
  },
  wind: {
    up: ['More output from wind turbines.',
      'Bigger waves and more coastal erosion.',
      'Faster evaporation from soils, lakes and crops.'],
    down: ['Less output from wind turbines.',
      'Air pollution and heat disperse more slowly over cities.',
      'Calmer seas and less wind erosion of soil.'],
  },
  uwnd: {
    up: ['The prevailing wind is becoming more westerly (blowing from the west).',
      'A change in wind direction changes where a place gets its storms, moisture and air pollution from.',
      'Along coasts it can shift ocean upwelling and with it local fisheries.'],
    down: ['The prevailing wind is becoming more easterly (blowing from the east).',
      'A change in wind direction changes where a place gets its storms, moisture and air pollution from.',
      'Along coasts it can shift ocean upwelling and with it local fisheries.'],
  },
  vwnd: {
    up: ['The prevailing wind is becoming more southerly (blowing from the south).',
      'More air arriving from lower or higher latitudes changes how warm and humid a place feels.',
      'It also changes where storms and moisture come from.'],
    down: ['The prevailing wind is becoming more northerly (blowing from the north).',
      'More air arriving from lower or higher latitudes changes how warm and humid a place feels.',
      'It also changes where storms and moisture come from.'],
  },
  cloud: {
    up: ['Cooler days and warmer nights, since cloud blocks sunlight and holds in heat after dark.',
      'Less output from solar panels.',
      'Usually comes with more rain or snow.'],
    down: ['More sunlight reaching the ground, so hotter days.',
      'More output from solar panels.',
      'Faster drying of soils and vegetation.'],
  },
  soil: {
    up: ['More water for crops and a buffer against short droughts.',
      'Waterlogged fields and more runoff into rivers when heavy rain falls.',
      'Wet soil keeps the air above it cooler in summer.'],
    down: ['Crop stress and a growing need for irrigation.',
      'Hotter heat waves, because dry ground heats the air instead of evaporating water.',
      'Drier vegetation and a higher wildfire risk.'],
  },
  soiltemp: {
    up: ['Earlier planting and a longer growing season.',
      'More crop pests and diseases surviving the winter.',
      'In cold regions, thawing permafrost that releases carbon and buckles roads and foundations.'],
    down: ['A later start to the growing season.',
      'Slower breakdown of plant matter in the soil.',
      'Longer-lasting frozen ground in cold regions.'],
  },
  ice: {
    up: ['A longer ice season and safer travel on the ice for northern communities.',
      'More bright ice reflects sunlight and keeps the region cooler.',
      'More habitat for seals, walrus and polar bears.'],
    down: ['Dark open water absorbs sunlight that ice would have reflected, which speeds up warming.',
      'Unsafe ice for hunting and travel, and more wave erosion of Arctic coasts.',
      'Less habitat for seals, walrus and polar bears, and more open water for shipping.'],
  },
  shortwave: {
    up: ['More sunlight at the ground, usually from fewer clouds or cleaner air.',
      'Hotter days and faster evaporation.',
      'More output from solar panels.'],
    down: ['Less sunlight at the ground, usually from more cloud, haze or smoke.',
      'Cooler days and slower evaporation.',
      'Less output from solar panels and slower crop growth.'],
  },
  latent: {
    up: ['More water is evaporating from the surface.',
      'On land that dries soils faster; over the ocean it feeds more moisture into storms.',
      'Evaporation also cools the surface, like sweat.'],
    down: ['Less water is evaporating, often because the soil has already dried out.',
      'More of the sun’s energy then heats the air instead, which makes heat waves worse.',
      'Less moisture is passed to the air for rain downwind.'],
  },
  sensible: {
    up: ['The ground is passing more heat directly to the air.',
      'That means hotter air near the surface, which is typical of drying land.',
      'Rising hot air can also stir up stronger afternoon winds and storms.'],
    down: ['The ground is passing less heat directly to the air.',
      'More of the energy goes into evaporating water instead, typical of wetter ground.',
      'Air near the surface stays cooler.'],
  },
  olr: {
    up: ['More heat is escaping to space, usually from clearer skies or a warmer surface.',
      'In the tropics this points to fewer tall rain clouds and drier conditions.',
      'Clearer skies also mean colder nights.'],
    down: ['Less heat is escaping to space, usually because of more high cloud.',
      'In the tropics this points to more tall rain clouds and wetter conditions.',
      'Heat held in by cloud keeps nights warmer.'],
  },
};

export function implications(key, rising, land) {
  const entry = LAYERS[key];
  if (!entry) return null;
  const side = entry.land ? entry[land ? 'land' : 'sea'] : entry;
  return side[rising ? 'up' : 'down'];
}
