
// Netlify Function: secure proxy for the 2GIS Routing API.
// Set DGIS_API_KEY in Netlify -> Site configuration -> Environment variables.
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        configured: Boolean(process.env.DGIS_API_KEY)
      })
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  const key = process.env.DGIS_API_KEY;

  if (!key) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({
        error: "2ГИС-ключ не настроен на сервере"
      })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const a = body.a || {};
    const b = body.b || {};

    for (const p of [a, b]) {
      if (
        !Number.isFinite(p.lat) ||
        !Number.isFinite(p.lng) ||
        p.lat < -90 || p.lat > 90 ||
        p.lng < -180 || p.lng > 180
      ) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Некорректные координаты"
          })
        };
      }
    }

    const upstream = await fetch(
      "https://routing.api.2gis.com/routing/7.0.0/global?key=" +
      encodeURIComponent(key),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          points: [
            { type: "stop", lon: a.lng, lat: a.lat },
            { type: "stop", lon: b.lng, lat: b.lat }
          ],
          transport: "driving",
          route_mode: "fastest",
          traffic_mode: "jam",
          output: "detailed",
          locale: "ru"
        })
      }
    );

    const payload = await upstream.json().catch(() => ({}));

    if (
      !upstream.ok ||
      payload.status !== "OK" ||
      !Array.isArray(payload.result) ||
      !payload.result.length
    ) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: String(
            payload.message ||
            payload.error ||
            `2ГИС HTTP ${upstream.status}`
          ).slice(0, 300)
        })
      };
    }

    const route = payload.result[0];
    const coordinates = [];

    const addWkt = (wkt) => {
      if (typeof wkt !== "string") return;

      const match = wkt.match(/LINESTRING\s*\((.*)\)/i);
      if (!match) return;

      for (const pair of match[1].split(",")) {
        const v = pair.trim().split(/\s+/).map(Number);

        if (
          v.length >= 2 &&
          Number.isFinite(v[0]) &&
          Number.isFinite(v[1])
        ) {
          coordinates.push([v[1], v[0]]);
        }
      }
    };

    addWkt(route.begin_pedestrian_path?.geometry?.selection);

    for (const maneuver of (route.maneuvers || [])) {
      const geometry = maneuver.outcoming_path?.geometry;

      if (Array.isArray(geometry)) {
        geometry.forEach(segment => addWkt(segment.selection));
      } else if (geometry?.selection) {
        addWkt(geometry.selection);
      }
    }

    addWkt(route.end_pedestrian_path?.geometry?.selection);

    const clean = coordinates.filter((p, i) =>
      i === 0 ||
      Math.abs(p[0] - coordinates[i - 1][0]) > 1e-8 ||
      Math.abs(p[1] - coordinates[i - 1][1]) > 1e-8
    );

    if (
      clean.length < 2 ||
      !Number.isFinite(route.total_distance) ||
      !Number.isFinite(route.total_duration)
    ) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "2ГИС не вернул корректную геометрию маршрута"
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        coordinates: clean,
        distance: route.total_distance,
        duration: route.total_duration,
        algorithm: route.algorithm || "fastest"
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Ошибка серверной маршрутизации: " +
          String(error.message || error).slice(0, 200)
      })
    };
  }
};
