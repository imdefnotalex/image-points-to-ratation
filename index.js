// Grab global elements
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const fileInput = document.getElementById("fileInput");
const startVideoButton = document.getElementById("startVideo");
const stopVideoButton = document.getElementById("stopVideo");
const coordsDisplay = document.getElementById("coords");
const angleDisplay = document.getElementById("angle");
const statusDisplay = document.getElementById("status");
const intervallToleranceInput = document.getElementById("intervall-tolerance");

intervallToleranceInput.onchange = (e) =>
  localStorage.setItem("intervallToleranceInput", e.target.value);
intervallToleranceInput.value =
  parseFloat(localStorage.getItem("intervallToleranceInput")) || 0.7;

let videoStream = null;
let useVideo = false;
let mousePos = { x: 0, y: 0 };
let selectedImage;

// Thresholds for clustering and collinearity
const CLUSTER_RADIUS = 100; // pixels: group nearby detections into one cluster
const COLLINEARITY_THRESHOLD = 50; // tolerance for a point to be considered "on the line"
const intervallTolerance = 0.8;

// ---------- Helper Functions ----------

// Euclidean distance between two points.
function distance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

// Given a list of clusters, add the point (x, y) to an existing cluster (if within threshold)
// Otherwise, create a new cluster.
function addToClusters(clusters, x, y, threshold) {
  for (let cluster of clusters) {
    const cx = cluster.sumX / cluster.count;
    const cy = cluster.sumY / cluster.count;
    if (distance({ x, y }, { x: cx, y: cy }) < threshold) {
      cluster.sumX += x;
      cluster.sumY += y;
      cluster.count++;
      return;
    }
  }
  clusters.push({ sumX: x, sumY: y, count: 1 });
}

// Cluster all pixels that pass the test function (color threshold)
// and return the centroid of the largest cluster, or null if none found.
function clusterColor(imageData, testFunc) {
  const clusters = [];
  const { width, height, data } = imageData;
  // Loop over pixels (step by 2 for speed)
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const index = (y * width + x) * 4;
      const r = data[index],
        g = data[index + 1],
        b = data[index + 2];
      if (testFunc(r, g, b)) {
        addToClusters(clusters, x, y, CLUSTER_RADIUS);
      }
    }
  }
  if (clusters.length === 0) return null;
  // Choose the cluster with the most pixels
  let best = clusters[0];
  for (let cluster of clusters) {
    if (cluster.count > best.count) best = cluster;
  }
  return { x: best.sumX / best.count, y: best.sumY / best.count };
}

// Color test functions using thresholds.
function isRed(r, g, b) {
  const max = Math.max(r, g, b);
  return max >= 110 && r === max && g < r * 0.5 && b < r * 0.5;
}

function isPink(r, g, b) {
  const max = Math.max(r, g, b);
  return max >= 110 && r === max && b > 80 && g < r * 0.5;
}

function isGreen(r, g, b) {
  const max = Math.max(r, g, b);
  return max >= 110 && g === max && r < g * 0.5 && b < g * 0.5;
}

// Compute the perpendicular distance from point p to the line through p1 and p2.
function pointLineDistance(p, p1, p2) {
  const num = Math.abs(
    (p2.y - p1.y) * p.x - (p2.x - p1.x) * p.y + p2.x * p1.y - p2.y * p1.x
  );
  const den = distance(p1, p2);
  return den === 0 ? 0 : num / den;
}

// Check if p1, mid, and p2 are collinear (i.e. mid is close to the line from p1 to p2).
function isCollinear(p1, mid, p2, threshold) {
  return pointLineDistance(mid, p1, p2) < threshold;
}

// Check if the points are in the expected order (pink should lie between red and green).
function checkOrder(red, pink, green, tolerance) {
  const dRP = distance(red, pink);
  const dPG = distance(pink, green);
  const dRG = distance(red, green);
  return Math.abs(dRP + dPG - dRG) < tolerance;
}

function checkEqualIntervals(red, pink, green) {
  const dRP = distance(red, pink);
  const dPG = distance(pink, green);
  const dRG = distance(red, green);

  const tolerance =
    parseFloat(intervallToleranceInput.value) ?? intervallTolerance;

  const min = 1 - tolerance;
  const max = 1 + tolerance;

  return (
    dPG > dRP * min &&
    dPG < dRP * max &&
    dRG > dRP * min * 2 &&
    dRG < dRP * max * 2
  );
}

// Compute the rotation (in degrees) required so that the line from the pink center toward red rotates to point at the mouse.
function computeRotation(middle, red, mouse) {
  const currentAngle = Math.atan2(red.y - middle.y, red.x - middle.x);
  const targetAngle = Math.atan2(mouse.y - middle.y, mouse.x - middle.x);
  let rotation = (targetAngle - currentAngle) * (180 / Math.PI);
  if (rotation > 180) rotation -= 360;
  if (rotation <= -180) rotation += 360;
  return rotation;
}

// ---------- Drawing Functions ----------

// Draw circles for each detected dot.
function drawDetections(dots) {
  if (dots.red) drawCircle(dots.red.x, dots.red.y, 10, "red");
  if (dots.pink) drawCircle(dots.pink.x, dots.pink.y, 10, "pink");
  if (dots.green) drawCircle(dots.green.x, dots.green.y, 10, "green");
}

// Draw a circle given a center, radius, and color.
function drawCircle(x, y, radius, color) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
}

// Draw a line between two points. Optionally, you can set the line width.
function drawLine(p1, p2, color, width = 3) {
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

// Draw a regionized line connecting red, pink, and green.
// This function draws two segments with a gradient: red→pink and pink→green.
function drawRegionizedLine(red, pink, green) {
  // Create gradient for red-to-pink segment
  let grad1 = ctx.createLinearGradient(red.x, red.y, pink.x, pink.y);
  grad1.addColorStop(0, "red");
  grad1.addColorStop(1, "pink");
  drawLine(red, pink, grad1, 4);

  // Create gradient for pink-to-green segment
  let grad2 = ctx.createLinearGradient(pink.x, pink.y, green.x, green.y);
  grad2.addColorStop(0, "pink");
  grad2.addColorStop(1, "green");
  drawLine(pink, green, grad2, 4);
}

// Resize the canvas.
function resizeCanvas(width, height) {
  canvas.width = width;
  canvas.height = height;
}

// ---------- Main Processing Functions ----------

// Detect the three colored dots from the image data.
function detectDots(imageData) {
  const redPoint = clusterColor(imageData, isRed);
  const pinkPoint = clusterColor(imageData, isPink);
  const greenPoint = clusterColor(imageData, isGreen);
  return { red: redPoint, pink: pinkPoint, green: greenPoint };
}

// Process each frame from the video (or after an image load).
function processFrame() {
  if (useVideo) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } else if (selectedImage) {
    ctx.drawImage(selectedImage, 0, 0);
  }
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const dots = detectDots(imageData);
  drawDetections(dots);

  if (dots.red && dots.pink && dots.green) {
    // Verify collinearity and order (pink should lie between red and green)
    if (
      isCollinear(dots.red, dots.pink, dots.green, COLLINEARITY_THRESHOLD) &&
      checkOrder(dots.red, dots.pink, dots.green, COLLINEARITY_THRESHOLD) &&
      checkEqualIntervals(dots.red, dots.pink, dots.green)
    ) {
      // Highlight the regionized color line pattern.
      drawRegionizedLine(dots.red, dots.pink, dots.green);

      drawCircle(dots.pink.x, dots.pink.y, 8, "rgb(180, 30, 100)");
      drawLine(dots.green, dots.red, "black", 5);
      // Use pink as the center point.
      const middleFront = dots.pink;
      middleFront.x += (dots.red.x - dots.pink.x) / 2;
      middleFront.y += (dots.red.y - dots.pink.y) / 2;

      drawCircle(middleFront.x, middleFront.y, 10, "blue");

      // If the mouse position is available, draw a blue marker and a blue line from the center to the mouse.
      if (mousePos.x !== null && mousePos.y !== null) {
        drawCircle(mousePos.x, mousePos.y, 5, "blue");
        drawLine(middleFront, mousePos, "blue");
        const rotation = computeRotation(middleFront, dots.red, mousePos);

        // coordsDisplay.textContent = `MiddleFront: (${middleFront.x.toFixed(
        //   2
        // )}, ${middleFront.y.toFixed(2)})`;

        if (Math.abs(rotation) < 90) {
          coordsDisplay.textContent = `The boat have to rotate ${
            rotation > 0 ? "right" : "left"
          } with factor ${Math.round((Math.abs(rotation) / 180) * 100)}%`;
        } else {
          coordsDisplay.textContent = `The boat have to turn ${
            rotation > 0 ? "right" : "left"
          } and then rotate ${
            rotation > 0 ? "right" : "left"
          } with factor ${Math.round(
            ((Math.abs(rotation) - 90) / 180) * 100
          )}%`;
        }

        angleDisplay.textContent = `Rotation to point toward mouse: ${rotation.toFixed(
          2
        )}°`;
      }
    } else {
      coordsDisplay.textContent =
        "Detected points are not collinear or in the correct order.";
      angleDisplay.textContent = "";
    }
  } else {
    coordsDisplay.textContent = "Not all dots detected.";
    angleDisplay.textContent = "";
  }

  requestAnimationFrame(processFrame);
}

// ---------- Video and Image Handling ----------

async function startVideo() {
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });

    video.srcObject = videoStream;
    useVideo = true;
    video.addEventListener("loadedmetadata", () => {
      resizeCanvas(video.videoWidth, video.videoHeight);
      processFrame();
    });
    statusDisplay.textContent = "Video started.";
  } catch (err) {
    console.error("Error accessing webcam:", err);
    statusDisplay.textContent = "Error accessing webcam.";
  }
}

function stopVideo() {
  useVideo = false;
  if (videoStream) {
    videoStream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
  statusDisplay.textContent = "Video stopped.";
}

// When an image file is selected, stop video and process the image.
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    const img = new Image();
    img.onload = () => {
      selectedImage = img;
      useVideo = false;
      stopVideo();
      resizeCanvas(img.width, img.height);
      ctx.drawImage(img, 0, 0);
      processFrame();
    };
    img.src = URL.createObjectURL(file);
  }
});

function start() {
  const img = new Image();
  img.onload = () => {
    selectedImage = img;
    useVideo = false;
    stopVideo();
    resizeCanvas(img.width, img.height);
    ctx.drawImage(img, 0, 0);
    processFrame();
  };
  img.src = "./test-images/working.jpeg";
}

// ---------- Mouse Handling ----------

// Update the mouse position relative to the canvas.
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  mousePos.x = (e.offsetX / rect.width) * canvas.width;
  mousePos.y = (e.offsetY / rect.height) * canvas.height;
});

canvas.addEventListener("touchmove", (e) => {
  e.preventDefault(); // Prevent scrolling while touching the canvas
  const rect = canvas.getBoundingClientRect();
  const touch = e.touches[0]; // Get first touch point

  mousePos.x = ((touch.clientX - rect.left) / rect.width) * canvas.width;
  mousePos.y = ((touch.clientY - rect.top) / rect.height) * canvas.height;
});

// ---------- Button Event Listeners ----------

startVideoButton.addEventListener("click", startVideo);
stopVideoButton.addEventListener("click", () => {
  stopVideo();
  start();
});

start();
