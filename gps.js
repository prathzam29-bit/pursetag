(() => {
	const $ = (id) => document.getElementById(id);
	const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
	const BLE_LOCATION_CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
	const BLE_RFID_CHARACTERISTIC_UUID = 'cba1d466-344c-4be3-ab3f-189f80dd7518';
	const RFID_NOTIFICATION_GRACE_MS = 15000;
	const PURSE_GPS_ERROR_METERS = 8;
	const els = {
		map: $('map'),
		distance: $('distanceValue'),
		distanceAccuracy: $('distanceAccuracy'),
		track: $('distanceTrackFill'),
		thresholdMarker: $('thresholdMarker'),
		rangeState: $('rangeState'),
		phoneCoordinates: $('phoneCoordinates'),
		phoneLocationStatus: $('phoneLocationStatus'),
		startPhoneLocation: $('startPhoneLocation'),
		locationStatus: $('locationStatus'),
		lastUpdated: $('lastUpdated'),
		connectionBadge: $('connectionBadge'),
		connectionLabel: $('connectionLabel'),
		deviceConnection: $('deviceConnection'),
		deviceDot: $('deviceDot'),
		connectBleButton: $('connectBleButton'),
		bleStatus: $('bleStatus'),
		threshold: $('thresholdInput'),
		alertBanner: $('alertBanner'),
		alertTitle: $('alertTitle'),
		alertMessage: $('alertMessage'),
		activityList: $('activityList'),
		toast: $('toast'),
		notificationIndicator: $('notificationIndicator'),
		rfidStatus: $('rfidStatus'),
		rfidItemList: $('rfidItemList'),
		rfidCard: $('rfidCard'),
	};

	const state = {
		current: null,
		phoneLocation: null,
		phoneWatchId: null,
		bleDevice: null,
		bleCharacteristic: null,
		bleRfidCharacteristic: null,
		map: null,
		purseMarker: null,
		phoneMarker: null,
		liveRoute: null,
		proximityCircle: null,
		connected: false,
		intentionalDisconnect: false,
		demo: false,
		pollTimer: null,
		toastTimer: null,
		wasOutside: false,
		outsideCount: 0,
		insideCount: 0,
		smoothedDistance: null,
		notified: false,
		notificationEnabled: false,
		alertDismissed: false,
		rfidMissingSince: new Map(),
		rfidAlertedMissingItems: new Set(),
	};

	function formatCoordinate(value) {
		return Number(value).toFixed(6);
	}

	function setStatus(message, connected = state.connected, alerting = false) {
		els.connectionLabel.textContent = message;
		els.connectionBadge.classList.toggle('connected', connected && !alerting);
		els.connectionBadge.classList.toggle('alerting', alerting);
		els.deviceConnection.textContent = state.demo ? 'Demo signal' : connected ? 'Bluetooth connected' : 'Not connected';
		els.deviceDot.classList.toggle('connected', connected);
	}

	function showToast(message) {
		els.toast.textContent = message;
		els.toast.classList.add('show');
		clearTimeout(state.toastTimer);
		state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3200);
	}

	function distanceInMeters(a, b) {
		const radians = (degrees) => degrees * Math.PI / 180;
		const earthRadius = 6371000;
		const dLat = radians(b.lat - a.lat);
		const dLon = radians(b.lon - a.lon);
		const lat1 = radians(a.lat);
		const lat2 = radians(b.lat);
		const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
		return earthRadius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
	}

	function getThreshold() {
		const threshold = Number(els.threshold.value);
		return Number.isFinite(threshold) ? Math.min(500, Math.max(1, threshold)) : 10;
	}

	function addActivity(title, detail, distance, isAlert = false) {
		const empty = els.activityList.querySelector('.empty-activity');
		if (empty) empty.remove();
		const item = document.createElement('div');
		item.className = 'activity-item';
		const icon = document.createElement('span');
		icon.className = `activity-icon${isAlert ? ' alert' : ''}`;
		icon.textContent = isAlert ? '!' : '⌖';
		const copy = document.createElement('span');
		copy.className = 'activity-copy';
		const heading = document.createElement('strong');
		heading.textContent = title;
		const subheading = document.createElement('small');
		subheading.textContent = detail;
		const value = document.createElement('span');
		value.className = 'activity-distance';
		value.textContent = distance == null ? '' : `${Math.round(distance)} m`;
		copy.append(heading, subheading);
		item.append(icon, copy, value);
		els.activityList.prepend(item);
		while (els.activityList.children.length > 6) els.activityList.lastElementChild.remove();
	}

	function updateMap() {
		if (!state.map) return;
		if (state.phoneLocation) {
			const phone = [state.phoneLocation.lat, state.phoneLocation.lon];
			if (!state.phoneMarker) {
				const personIcon = L.divIcon({ className: 'tracker-sprite-icon', html: '<span class="tracker-sprite person-sprite" role="img" aria-label="Person">🧍</span>', iconSize: [36, 42], iconAnchor: [18, 36] });
				state.phoneMarker = L.marker(phone, { icon: personIcon, zIndexOffset: 1000 }).addTo(state.map);
				state.phoneMarker.bindTooltip('You', { direction: 'top', offset: [0, -30] });
				state.proximityCircle = L.circle(phone, { radius: getThreshold(), color: '#71977a', weight: 1, fillColor: '#9cbea2', fillOpacity: 0.14 }).addTo(state.map);
			} else {
				state.phoneMarker.setLatLng(phone);
				state.proximityCircle.setLatLng(phone).setRadius(getThreshold());
			}
		}
		if (state.current) {
			const point = [state.current.lat, state.current.lon];
			if (!state.purseMarker) {
				const purseIcon = L.divIcon({ className: 'tracker-sprite-icon', html: '<span class="tracker-sprite purse-sprite" role="img" aria-label="Wallet">👛</span>', iconSize: [36, 42], iconAnchor: [18, 36] });
				state.purseMarker = L.marker(point, { icon: purseIcon }).addTo(state.map);
				state.purseMarker.bindTooltip('Your wallet', { direction: 'top', offset: [0, -30] });
			} else {
				state.purseMarker.setLatLng(point);
			}
			if (!state.phoneLocation) state.map.setView(point, 17);
		}
		if (state.current && state.phoneLocation && !state.map._hasCenteredPair) {
			state.map.fitBounds(L.latLngBounds([[state.current.lat, state.current.lon], [state.phoneLocation.lat, state.phoneLocation.lon]]).pad(0.45), { maxZoom: 18 });
			state.map._hasCenteredPair = true;
		}
		if (state.current && state.phoneLocation) {
			const route = [[state.phoneLocation.lat, state.phoneLocation.lon], [state.current.lat, state.current.lon]];
			if (!state.liveRoute) {
				state.liveRoute = L.polyline(route, {
					color: '#4285F4',
					weight: 5,
					opacity: 0.9,
					lineCap: 'round',
					lineJoin: 'round',
				}).addTo(state.map);
			} else {
				state.liveRoute.setLatLngs(route);
			}
		} else if (state.liveRoute) {
			state.map.removeLayer(state.liveRoute);
			state.liveRoute = null;
		}
	}

	function smoothPoint(previous, point, alpha = 0.5) {
		if (!previous) return { ...point };
		return {
			...point,
			lat: previous.lat + alpha * (point.lat - previous.lat),
			lon: previous.lon + alpha * (point.lon - previous.lon),
		};
	}

	function stabilizePoint(previous, point, deadbandMeters) {
		if (!previous) return { ...point };
		if (distanceInMeters(previous, point) <= deadbandMeters) {
			return { ...point, lat: previous.lat, lon: previous.lon };
		}
		return smoothPoint(previous, point, 0.5);
	}

	function renderDistance() {
		if (!state.current || !state.phoneLocation) {
			els.distance.textContent = '—';
			els.distanceAccuracy.textContent = 'Waiting for location accuracy';
			els.rangeState.textContent = !state.phoneLocation ? 'Share phone location first' : 'Waiting for purse GPS';
			return;
		}

		const rawDistance = distanceInMeters(state.current, state.phoneLocation);
		const phoneAccuracy = Number.isFinite(state.phoneLocation.accuracy) ? state.phoneLocation.accuracy : 12;
		// Combine the browser-reported phone accuracy with a conservative allowance
		// for a NEO-6M fix. This is not a calibrated confidence interval.
		const uncertainty = phoneAccuracy + PURSE_GPS_ERROR_METERS;
		const minimumSeparation = Math.max(0, rawDistance - uncertainty);
		const maximumSeparation = rawDistance + uncertainty;
		state.smoothedDistance = rawDistance;
		const threshold = getThreshold();
		const wasOutside = state.wasOutside;
		if (!wasOutside) {
			state.outsideCount = minimumSeparation > threshold ? state.outsideCount + 1 : 0;
		} else {
			state.insideCount = maximumSeparation < threshold * 0.8 ? state.insideCount + 1 : 0;
		}
		if (!wasOutside && state.outsideCount >= 3) {
			state.wasOutside = true;
			state.outsideCount = 0;
		} else if (wasOutside && state.insideCount >= 3) {
			state.wasOutside = false;
			state.insideCount = 0;
		}

		const outside = state.wasOutside;
		els.distance.textContent = minimumSeparation === 0 ? '0' : `≥${Math.round(minimumSeparation).toLocaleString()}`;
		els.distanceAccuracy.textContent = `GPS reads ${Math.round(rawDistance)} m; estimated uncertainty allowance ±${Math.round(uncertainty)} m`;
		els.track.style.width = `${Math.min(100, minimumSeparation / (threshold * 2) * 100)}%`;
		els.track.classList.toggle('outside', outside);
		els.thresholdMarker.style.left = `${Math.min(96, threshold / (threshold * 2) * 100)}%`;
		els.rangeState.textContent = outside
			? 'Beyond phone distance limit'
			: maximumSeparation >= threshold && minimumSeparation <= threshold
				? 'GPS error overlaps the alert limit'
				: 'Within phone distance limit';
		els.rangeState.classList.toggle('outside', outside);
		if (state.proximityCircle) state.proximityCircle.setRadius(threshold);

		if (outside && !wasOutside) {
			const message = `Purse is beyond ${threshold} m from your phone, accounting for estimated GPS error.`;
			els.alertTitle.textContent = 'Purse is away from your phone';
			els.alertMessage.textContent = message;
			els.alertBanner.classList.add('visible');
			setStatus('Purse out of range', true, true);
			addActivity('Purse is beyond distance limit', `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, rawDistance, true);
			notifyUser(message);
		} else if (!outside && wasOutside) {
			els.alertBanner.classList.remove('visible');
			setStatus('Purse back near phone', true);
			addActivity('Purse returned within range', `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, rawDistance);
		} else if (state.connected) {
			setStatus(outside ? 'Purse out of range' : 'Tracking live', true, outside);
		}
	}

	function updateLocation(point, source = 'ESP32') {
		if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
			throw new Error('GPS response has invalid latitude or longitude.');
		}
		state.current = stabilizePoint(state.current, point, PURSE_GPS_ERROR_METERS / 2);
		const now = new Date();
		els.locationStatus.textContent = `${source} location received`;
		$('map').setAttribute('aria-label', `Purse location at ${formatCoordinate(state.current.lat)}, ${formatCoordinate(state.current.lon)}`);
		els.lastUpdated.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
		updateMap();
		renderDistance();
	}

	function updatePhoneLocation(point) {
		const phoneDeadband = Math.max(3, Math.min(8, (point.accuracy || 10) * 0.4));
		state.phoneLocation = stabilizePoint(state.phoneLocation, point, phoneDeadband);
		els.phoneCoordinates.textContent = `${formatCoordinate(state.phoneLocation.lat)}, ${formatCoordinate(state.phoneLocation.lon)} · ±${Math.round(point.accuracy)} m estimated accuracy`;
		els.phoneLocationStatus.textContent = 'Sharing live location while this page stays open';
		els.startPhoneLocation.textContent = 'Phone location is sharing';
		updateMap();
		renderDistance();
	}

	function notifyUser(message) {
		showToast(message);
		if (state.notificationEnabled && 'Notification' in window && Notification.permission === 'granted') {
			new Notification('PurseGuard alert', { body: message, tag: 'purse-out-of-range' });
		}
	}

	function startPhoneLocationWatch() {
		if (!navigator.geolocation) {
			return showToast('This browser does not support location sharing.');
		}
		if (state.phoneWatchId !== null) {
			navigator.geolocation.clearWatch(state.phoneWatchId);
			state.phoneWatchId = null;
			state.phoneLocation = null;
			state.smoothedDistance = null;
			if (state.map && state.phoneMarker) state.map.removeLayer(state.phoneMarker);
			if (state.map && state.proximityCircle) state.map.removeLayer(state.proximityCircle);
			state.phoneMarker = null;
			state.proximityCircle = null;
			els.phoneCoordinates.textContent = 'Phone location sharing stopped';
			els.phoneLocationStatus.textContent = 'Start location sharing to measure distance';
			els.startPhoneLocation.textContent = 'Share phone location';
			els.alertBanner.classList.remove('visible');
			state.wasOutside = false;
			state.outsideCount = 0;
			state.insideCount = 0;
			renderDistance();
			return;
		}
		if (!window.isSecureContext) {
			return showToast('Phone location needs a secure HTTPS page (or localhost during development).');
		}
		if (state.phoneWatchId !== null) return showToast('Phone location is already sharing.');
		state.phoneLocation = null;
		state.smoothedDistance = null;
		state.wasOutside = false;
		state.outsideCount = 0;
		state.insideCount = 0;
		if (state.map && state.phoneMarker) state.map.removeLayer(state.phoneMarker);
		if (state.map && state.proximityCircle) state.map.removeLayer(state.proximityCircle);
		state.phoneMarker = null;
		state.proximityCircle = null;
		if (state.map) state.map._hasCenteredPair = false;
		els.phoneLocationStatus.textContent = 'Waiting for location permission…';
		state.phoneWatchId = navigator.geolocation.watchPosition(
			(position) => updatePhoneLocation({
				lat: position.coords.latitude,
				lon: position.coords.longitude,
				accuracy: position.coords.accuracy,
			}),
			(error) => {
				state.phoneWatchId = null;
				const message = error.code === 1 ? 'Location permission denied. Allow it in Android Chrome site settings.' : 'Could not read phone location. Check Android Location Services.';
				els.phoneLocationStatus.textContent = message;
				els.startPhoneLocation.textContent = 'Share phone location';
				showToast(message);
			},
			{ enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
		);
		els.startPhoneLocation.textContent = 'Requesting phone location…';
	}

	function handleBlePayload(dataView) {
		const text = new TextDecoder().decode(dataView);
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			els.bleStatus.textContent = 'Received unreadable data from PurseGuard';
			return;
		}
		if (data.fix === false) {
			state.current = null;
			state.smoothedDistance = null;
			els.locationStatus.textContent = 'Connected · waiting for a fresh GPS fix';
			els.bleStatus.textContent = 'Bluetooth connected · GPS waiting for satellite fix';
			renderDistance();
			return;
		}
		const lat = Number(data.lat);
		const lon = Number(data.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			els.bleStatus.textContent = 'GPS packet has no valid coordinates';
			return;
		}
		updateLocation({ lat, lon, sats: Number(data.sats) || undefined }, 'PurseGuard BLE');
		els.bleStatus.textContent = `Bluetooth connected · ${Number(data.sats) || '?'} GPS satellites`;
	}

	function renderRfidStatus(values) {
		const names = ['House Keys', 'Office Tag', 'Spare'];
		const items = names.map((name, index) => ({ name, present: values[index] === '1' }));
		const missing = items.filter((item) => !item.present).map((item) => item.name);

		els.rfidStatus.textContent = missing.length ? `Missing: ${missing.join(', ')}` : 'All tracked items are present';
		els.rfidCard.classList.toggle('has-missing-items', missing.length > 0);
		els.rfidItemList.replaceChildren();
		for (const item of items) {
			const row = document.createElement('div');
			row.className = `rfid-item${item.present ? ' present' : ' missing'}`;
			const marker = document.createElement('span');
			marker.className = 'rfid-item-marker';
			marker.textContent = item.present ? '✓' : '!';
			const label = document.createElement('span');
			label.textContent = item.name;
			const status = document.createElement('small');
			status.textContent = item.present ? 'PRESENT' : 'MISSING';
			row.append(marker, label, status);
			els.rfidItemList.append(row);
		}

		const now = Date.now();
		for (const item of items) {
			if (item.present) {
				state.rfidMissingSince.delete(item.name);
				state.rfidAlertedMissingItems.delete(item.name);
				continue;
			}

			if (!state.rfidMissingSince.has(item.name)) {
				state.rfidMissingSince.set(item.name, now);
			}
			const missingForMs = now - state.rfidMissingSince.get(item.name);
			if (missingForMs < RFID_NOTIFICATION_GRACE_MS) continue;
			if (state.rfidAlertedMissingItems.has(item.name)) continue;

			state.rfidAlertedMissingItems.add(item.name);
			const message = `${item.name} has been missing for 15 seconds.`;
			addActivity('RFID item missing', message, null, true);
			showToast(message);
			if (state.notificationEnabled && 'Notification' in window && Notification.permission === 'granted') {
				new Notification('PurseGuard: item missing', { body: message });
			}
		}
	}

	function handleRfidPayload(dataView) {
		const payload = new TextDecoder().decode(dataView).trim();
		if (payload === 'RFID,WAIT') {
			els.rfidStatus.textContent = 'Waiting for fresh RFID status from STM32';
			els.rfidItemList.replaceChildren();
			els.rfidCard.classList.remove('has-missing-items');
			state.rfidMissingSince.clear();
			state.rfidAlertedMissingItems.clear();
			return;
		}

		const parts = payload.split(',');
		if (parts.length !== 4 || parts[0] !== 'RFID' || parts.slice(1).some((value) => value !== '0' && value !== '1')) {
			els.rfidStatus.textContent = 'Invalid RFID data from PurseGuard';
			return;
		}
		renderRfidStatus(parts.slice(1));
	}

	function onBleDisconnected() {
		state.connected = false;
		state.bleCharacteristic = null;
		state.bleRfidCharacteristic = null;
		els.rfidStatus.textContent = 'Bluetooth disconnected · RFID unavailable';
		els.rfidItemList.replaceChildren();
		els.rfidCard.classList.remove('has-missing-items');
		state.rfidMissingSince.clear();
		state.rfidAlertedMissingItems.clear();
		els.connectBleButton.textContent = 'Connect purse via Bluetooth';
		els.connectBleButton.classList.remove('connected');
		els.deviceConnection.textContent = 'Bluetooth disconnected';
		els.deviceDot.classList.remove('connected');
		els.locationStatus.textContent = 'Bluetooth connection lost · showing last known location';
		els.bleStatus.textContent = 'Disconnected · tap to reconnect';
		if (!state.intentionalDisconnect && !state.demo) {
			const message = 'Bluetooth connection to your purse was lost. It may be out of range.';
			els.alertTitle.textContent = 'Purse Bluetooth connection lost';
			els.alertMessage.textContent = message;
			els.alertBanner.classList.add('visible');
			setStatus('Bluetooth disconnected', false, true);
			notifyUser(message);
		}
		state.intentionalDisconnect = false;
	}

	async function connectBluetooth() {
		if (state.bleDevice?.gatt?.connected) {
			state.intentionalDisconnect = true;
			state.bleDevice.gatt.disconnect();
			return;
		}
		if (!window.isSecureContext) {
			return showToast('Bluetooth requires a secure HTTPS website (or localhost for local testing).');
		}
		if (!navigator.bluetooth) {
			return showToast('Web Bluetooth is unavailable in this browser. Open this HTTPS page in Chrome on Android.');
		}
		els.connectBleButton.disabled = true;
		els.bleStatus.textContent = 'Choose PurseGuard in the Bluetooth picker…';
		try {
			state.bleDevice = await navigator.bluetooth.requestDevice({
				filters: [{ name: 'PurseGuard' }],
				optionalServices: [BLE_SERVICE_UUID],
			});
			state.bleDevice.addEventListener('gattserverdisconnected', onBleDisconnected);
			const server = await state.bleDevice.gatt.connect();
			const service = await server.getPrimaryService(BLE_SERVICE_UUID);
			state.bleCharacteristic = await service.getCharacteristic(BLE_LOCATION_CHARACTERISTIC_UUID);
			state.bleCharacteristic.addEventListener('characteristicvaluechanged', (event) => handleBlePayload(event.target.value));
			await state.bleCharacteristic.startNotifications();
			state.connected = true;
			state.demo = false;
			state.current = null;
			state.smoothedDistance = null;
			state.wasOutside = false;
			state.outsideCount = 0;
			state.insideCount = 0;
			els.connectBleButton.textContent = 'Disconnect Bluetooth';
			els.connectBleButton.classList.add('connected');
			els.deviceConnection.textContent = 'Bluetooth connected';
			els.deviceDot.classList.add('connected');
			setStatus('Connected to PurseGuard', true);
			els.bleStatus.textContent = 'Connected · receiving GPS updates';
			try {
				handleBlePayload(await state.bleCharacteristic.readValue());
			} catch (error) {
				els.bleStatus.textContent = `Bluetooth connected · waiting for GPS notification (${error.message})`;
			}
			try {
				state.bleRfidCharacteristic = await service.getCharacteristic(BLE_RFID_CHARACTERISTIC_UUID);
				state.bleRfidCharacteristic.addEventListener('characteristicvaluechanged', (event) => handleRfidPayload(event.target.value));
				await state.bleRfidCharacteristic.startNotifications();
				handleRfidPayload(await state.bleRfidCharacteristic.readValue());
			} catch (error) {
				state.bleRfidCharacteristic = null;
				els.rfidStatus.textContent = `GPS connected · RFID GATT error: ${error.message}`;
				els.rfidItemList.replaceChildren();
				els.rfidCard.classList.remove('has-missing-items');
				state.rfidMissingSince.clear();
				state.rfidAlertedMissingItems.clear();
				showToast(`GPS connected, but RFID setup failed: ${error.message}`);
			}
		} catch (error) {
			const message = error.name === 'NotFoundError'
				? 'No device selected. Check ESP32 power and BLE firmware.'
				: `${error.name}: ${error.message}`;
			els.bleStatus.textContent = `Bluetooth connection failed: ${message}`;
			showToast(message);
		} finally {
			els.connectBleButton.disabled = false;
		}
	}

	function startDemo() {
		if (state.bleDevice?.gatt?.connected) {
			state.intentionalDisconnect = true;
			state.bleDevice.gatt.disconnect();
		}
		if (state.phoneWatchId !== null) {
			navigator.geolocation.clearWatch(state.phoneWatchId);
			state.phoneWatchId = null;
		}
		state.connected = true;
		state.demo = true;
		state.wasOutside = false;
		state.outsideCount = 0;
		state.insideCount = 0;
		state.smoothedDistance = null;
		els.connectBleButton.textContent = 'Demo running';
		els.connectBleButton.classList.add('connected');
		const origin = { lat: 12.9716, lon: 77.5946 };
		state.phoneLocation = { ...origin, accuracy: 5 };
		els.phoneCoordinates.textContent = `${formatCoordinate(origin.lat)}, ${formatCoordinate(origin.lon)} · demo`;
		els.phoneLocationStatus.textContent = 'Demo phone position';
		els.startPhoneLocation.textContent = 'Demo location active';
		setStatus('Demo tracking', true);
		els.bleStatus.textContent = 'Demo running locally. Connect your ESP32 when ready.';
		let step = 0;
		updateLocation(origin, 'Demo');
		state.pollTimer = setInterval(() => {
			step += 1;
			const offsets = step % 8 < 4 ? [0.000025, 0.000035, 0.00006, 0.0001] : [0.00009, 0.00004, 0.00002, 0.000005];
			updateLocation({ lat: origin.lat + offsets[step % offsets.length], lon: origin.lon + offsets[(step + 1) % offsets.length] }, 'Demo');
		}, 1500);
		showToast('Demo started. Watch the location and distance update.');
	}

	function toggleNotifications() {
		if (!('Notification' in window)) {
			showToast('This browser does not support desktop notifications.');
			return;
		}
		if (Notification.permission === 'granted') {
			state.notificationEnabled = !state.notificationEnabled;
			els.notificationIndicator.classList.toggle('enabled', state.notificationEnabled);
			showToast(state.notificationEnabled ? 'Browser notifications enabled.' : 'Browser notifications paused.');
			return;
		}
		Notification.requestPermission().then((permission) => {
			state.notificationEnabled = permission === 'granted';
			els.notificationIndicator.classList.toggle('enabled', state.notificationEnabled);
			showToast(state.notificationEnabled ? 'Browser notifications enabled.' : 'Notification permission was not granted.');
		});
	}

	function initialize() {
		if (window.L) {
			state.map = L.map(els.map, { zoomControl: false }).setView([20.5937, 78.9629], 5);
			L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				maxZoom: 19,
				attribution: '&copy; OpenStreetMap contributors',
			}).addTo(state.map);
			L.control.zoom({ position: 'bottomright' }).addTo(state.map);
		} else {
			els.map.innerHTML = '<div style="height:100%;display:grid;place-items:center;color:#728176;font-size:12px">Map needs an internet connection. GPS distance tracking still works.</div>';
		}

		els.startPhoneLocation.addEventListener('click', startPhoneLocationWatch);
		els.connectBleButton.addEventListener('click', connectBluetooth);
		$('demoButton').addEventListener('click', startDemo);
		$('notificationButton').addEventListener('click', toggleNotifications);
		$('dismissAlert').addEventListener('click', () => {
			els.alertBanner.classList.remove('visible');
			state.alertDismissed = true;
		});
		$('centerMapButton').addEventListener('click', () => {
			if (!state.current && !state.phoneLocation) return showToast('No location to center on yet.');
			if (!state.map || !window.L) return showToast('Map is unavailable without an internet connection.');
			const points = [state.current, state.phoneLocation].filter(Boolean).map(({ lat, lon }) => [lat, lon]);
			if (points.length > 1) state.map.fitBounds(L.latLngBounds(points).pad(0.45), { maxZoom: 18 });
			else state.map.setView(points[0], 17);
		});
		$('clearActivityButton').addEventListener('click', () => {
			els.activityList.innerHTML = '<div class="empty-activity"><span>◎</span><p>Nothing to report yet</p><small>Location updates will show up here.</small></div>';
		});
		els.threshold.addEventListener('change', () => {
			const value = getThreshold();
			els.threshold.value = value;
			if (state.proximityCircle) state.proximityCircle.setRadius(value);
			renderDistance();
		});
		$('privacyLink').addEventListener('click', (event) => {
			event.preventDefault();
			showToast('The page uses Bluetooth for the ESP32 and browser location for this phone. Use Android Chrome over HTTPS and keep the page open.');
		});
	}

	initialize();
})();
