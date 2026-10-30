/**
 * PDF 문서 보안 워터마크 웹 애플리케이션
 * - 100% 브라우저 로컬 메모리 처리 (외부 유출 방지)
 * - 한국어 텍스트 지원 (오프라인 Canvas 텍스트 벡터/PNG 투명 레이어 오버레이 방식)
 * - 개별 PDF 다운로드 & JSZip 일괄 압축 다운로드
 */

// pdf.js 워커 경로 로컬 설정
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
}

// 전역 상태 관리
const state = {
  selectedFiles: [], // File 객체 배열
  processedDocs: [], // { name, pdfBytes, pageCount, objectUrl }
  currentPreviewIdx: 0,
  currentPreviewPage: 1,
  totalPreviewPages: 1,
  pdfJsDoc: null
};

// DOM 요소 참조
const els = {
  userName: document.getElementById('userName'),
  userIp: document.getElementById('userIp'),
  customTime: document.getElementById('customTime'),
  btnAutoIp: document.getElementById('btnAutoIp'),
  fileInput: document.getElementById('fileInput'),
  dropZone: document.getElementById('dropZone'),
  fileListContainer: document.getElementById('fileListContainer'),
  fileList: document.getElementById('fileList'),
  fileCount: document.getElementById('fileCount'),
  btnClearFiles: document.getElementById('btnClearFiles'),
  btnProcess: document.getElementById('btnProcess'),
  progressBox: document.getElementById('progressBox'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  progressPercent: document.getElementById('progressPercent'),
  btnDownloadAll: document.getElementById('btnDownloadAll'),
  previewToolbar: document.getElementById('previewToolbar'),
  previewDocSelect: document.getElementById('previewDocSelect'),
  prevPageBtn: document.getElementById('prevPageBtn'),
  nextPageBtn: document.getElementById('nextPageBtn'),
  currentPageNum: document.getElementById('currentPageNum'),
  totalPagesNum: document.getElementById('totalPagesNum'),
  btnDownloadCurrent: document.getElementById('btnDownloadCurrent'),
  previewViewport: document.getElementById('previewViewport'),
  emptyState: document.getElementById('emptyState'),
  canvasContainer: document.getElementById('canvasContainer'),
  pdfCanvas: document.getElementById('pdfCanvas'),
  viewerLoader: document.getElementById('viewerLoader'),
  completedSection: document.getElementById('completedSection'),
  completedTableBody: document.getElementById('completedTableBody'),
  optionsToggle: document.getElementById('optionsToggle'),
  optionsAccordion: document.querySelector('.options-accordion'),
  optFontSize: document.getElementById('optFontSize'),
  valFontSize: document.getElementById('valFontSize'),
  optOpacity: document.getElementById('optOpacity'),
  valOpacity: document.getElementById('valOpacity'),
  optAngle: document.getElementById('optAngle'),
  valAngle: document.getElementById('valAngle'),
  optDensity: document.getElementById('optDensity'),
  valDensity: document.getElementById('valDensity')
};

// 1. 실시간 시계 업데이트 (초 단위)
function updateClock() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  els.customTime.value = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}
setInterval(updateClock, 1000);
updateClock();

// 2. IP 자동 감지 시도 (로컬 WebRTC 탐색 및 Fallback)
async function detectLocalOrPublicIP() {
  els.btnAutoIp.disabled = true;
  const originalText = els.btnAutoIp.innerHTML;
  els.btnAutoIp.innerText = '감지 중...';

  // 먼저 외부 공인 IP API 가벼운 핑 (선택적)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data && data.ip) {
        els.userIp.value = data.ip;
        els.btnAutoIp.disabled = false;
        els.btnAutoIp.innerHTML = originalText;
        return;
      }
    }
  } catch (e) {
    console.log('Public IP lookup skipped or timed out, trying WebRTC local candidate.');
  }

  // WebRTC로 내부망 IP 감지 시도
  try {
    const rtc = new RTCPeerConnection({ iceServers: [] });
    rtc.createDataChannel('');
    rtc.createOffer().then(offer => rtc.setLocalDescription(offer));
    rtc.onicecandidate = (event) => {
      if (!event || !event.candidate) return;
      const candidate = event.candidate.candidate;
      const ipMatch = candidate.match(/([0-9]{1,3}(\.[0-9]{1,3}){3})/);
      if (ipMatch && ipMatch[1] && !ipMatch[1].startsWith('0.')) {
        els.userIp.value = ipMatch[1];
        rtc.close();
      }
    };
  } catch (err) {
    console.warn('WebRTC IP detection not allowed:', err);
  }

  setTimeout(() => {
    els.btnAutoIp.disabled = false;
    els.btnAutoIp.innerHTML = originalText;
  }, 1200);
}

els.btnAutoIp.addEventListener('click', detectLocalOrPublicIP);

// 3. 옵션 아코디언 및 슬라이더 이벤트
els.optionsToggle.addEventListener('click', () => {
  els.optionsAccordion.classList.toggle('open');
});

els.optFontSize.addEventListener('input', (e) => {
  els.valFontSize.textContent = `${e.target.value} pt`;
});

els.optOpacity.addEventListener('input', (e) => {
  els.valOpacity.textContent = `${e.target.value}%`;
});

els.optAngle.addEventListener('input', (e) => {
  els.valAngle.textContent = `${e.target.value}°`;
});

const densityLabels = { '1': '넓게 (여유)', '2': '보통 (촘촘함)', '3': '매우 촘촘 (보안 강화)' };
els.optDensity.addEventListener('input', (e) => {
  els.valDensity.textContent = densityLabels[e.target.value] || '보통';
});

// 4. 파일 드롭존 및 파일 목록 관리
function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function handleFiles(files) {
  const newPdfFiles = Array.from(files).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (newPdfFiles.length === 0) {
    alert('PDF 파일만 선택해주세요.');
    return;
  }

  // 중복 파일명 방지 또는 추가
  newPdfFiles.forEach(newFile => {
    if (!state.selectedFiles.some(existing => existing.name === newFile.name && existing.size === newFile.size)) {
      state.selectedFiles.push(newFile);
    }
  });

  renderFileList();
}

function renderFileList() {
  if (state.selectedFiles.length === 0) {
    els.fileListContainer.style.display = 'none';
    els.btnProcess.disabled = true;
    els.fileCount.textContent = '0';
    return;
  }

  els.fileListContainer.style.display = 'flex';
  els.fileCount.textContent = state.selectedFiles.length;
  els.btnProcess.disabled = false;
  els.fileList.innerHTML = '';

  state.selectedFiles.forEach((file, index) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.innerHTML = `
      <div class="file-info">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#60a5fa" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span class="file-name" title="${file.name}">${file.name}</span>
        <span class="file-size">(${formatBytes(file.size)})</span>
      </div>
      <button type="button" class="file-remove" data-index="${index}" title="삭제">✕</button>
    `;
    els.fileList.appendChild(li);
  });

  // 개별 파일 삭제
  els.fileList.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      state.selectedFiles.splice(idx, 1);
      renderFileList();
    });
  });
}

els.btnClearFiles.addEventListener('click', () => {
  state.selectedFiles = [];
  els.fileInput.value = '';
  renderFileList();
});

// 드래그 앤 드롭 리스너
['dragenter', 'dragover'].forEach(eventName => {
  els.dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(eventName => {
  els.dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.classList.remove('dragover');
  });
});

els.dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files) {
    handleFiles(e.dataTransfer.files);
  }
});

els.fileInput.addEventListener('change', (e) => {
  if (e.target.files) {
    handleFiles(e.target.files);
  }
});

// 5. 워터마크 이미지 생성 (Canvas 활용하여 한글 폰트 완벽 지원)
/**
 * 고해상도 Canvas를 사용해 각 페이지 크기(Width, Height)에 맞추어
 * 회전된 미세 워터마크 패턴을 반복 렌더링하고 투명 PNG 바이트로 반환합니다.
 */
function createWatermarkOverlayPng(pageWidth, pageHeight, watermarkConfig) {
  // 선명도를 위해 2배 스케일 렌더링
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(pageWidth * scale);
  canvas.height = Math.ceil(pageHeight * scale);
  const ctx = canvas.getContext('2d');

  ctx.scale(scale, scale);

  const { lines, fontSize, opacity, angleDeg, density, colorType } = watermarkConfig;

  // 색상 매핑
  let colorRgb = '100, 116, 139'; // gray
  if (colorType === 'red') colorRgb = '220, 38, 38';
  if (colorType === 'blue') colorRgb = '37, 99, 235';

  ctx.fillStyle = `rgba(${colorRgb}, ${opacity})`;
  ctx.font = `600 ${fontSize}pt 'Pretendard', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 밀도별 간격 계산
  let stepX = 220;
  let stepY = 160;
  if (density === 1) { stepX = 300; stepY = 220; } // 넓게
  if (density === 3) { stepX = 160; stepY = 120; } // 매우 촘촘

  const angleRad = (angleDeg * Math.PI) / 180;
  const lineHeight = fontSize * 1.35;

  // 페이지 전체를 넉넉하게 덮도록 여유 범위 루프
  const margin = 200;
  const startX = -margin;
  const endX = pageWidth + margin;
  const startY = -margin;
  const endY = pageHeight + margin;

  let rowIndex = 0;
  for (let y = startY; y < endY; y += stepY) {
    // 엇갈린 벽돌(Brick) 패턴으로 인쇄 시 틈새 없이 보안성 극대화
    const offsetX = (rowIndex % 2 === 0) ? 0 : stepX / 2;
    for (let x = startX; x < endX; x += stepX) {
      ctx.save();
      ctx.translate(x + offsetX, y);
      ctx.rotate(angleRad);

      // 다중 라인 출력 (1: 안내문구, 2: 출력자명, 3: IP, 4: 시간)
      const totalBlockHeight = lines.length * lineHeight;
      const startTextY = -totalBlockHeight / 2 + lineHeight / 2;

      lines.forEach((line, i) => {
        ctx.fillText(line, 0, startTextY + (i * lineHeight));
      });

      ctx.restore();
    }
    rowIndex++;
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve(new Uint8Array(reader.result));
      };
      reader.readAsArrayBuffer(blob);
    }, 'image/png');
  });
}

// 6. PDF 워터마크 삽입 메인 처리 함수
async function processAllPdfs() {
  const userName = els.userName.value.trim() || '미지정 사용자';
  const userIp = els.userIp.value.trim() || 'IP 미확인';
  const printTime = els.customTime.value.trim() || new Date().toLocaleString();

  // 워터마크 라인 구성
  const lines = [
    `[SECURE PRINT]`,
    `출력자: ${userName}`,
    `IP: ${userIp}`,
    `일시: ${printTime}`,
    `무단배포 및 유출금지`
  ];

  const fontSize = parseFloat(els.optFontSize.value);
  const opacity = parseFloat(els.optOpacity.value) / 100;
  const angleDeg = parseFloat(els.optAngle.value);
  const density = parseInt(els.optDensity.value, 10);
  
  const selectedColorEl = document.querySelector('input[name="wmColor"]:checked');
  const colorType = selectedColorEl ? selectedColorEl.value : 'gray';

  const watermarkConfig = { lines, fontSize, opacity, angleDeg, density, colorType };

  // UI 진행상태 초기화
  els.btnProcess.disabled = true;
  els.progressBox.style.display = 'flex';
  els.progressBar.style.width = '0%';
  els.progressPercent.textContent = '0%';
  els.progressText.textContent = '준비 중...';

  // 이전 결과 URL 메모리 해제
  state.processedDocs.forEach(doc => {
    if (doc.objectUrl) URL.revokeObjectURL(doc.objectUrl);
  });
  state.processedDocs = [];

  const totalFiles = state.selectedFiles.length;

  for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
    const file = state.selectedFiles[fileIdx];
    els.progressText.textContent = `[${fileIdx + 1}/${totalFiles}] "${file.name}" 워터마크 각인 중...`;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFLib.PDFDocument.load(arrayBuffer);
      const pages = pdfDoc.getPages();
      const pageCount = pages.length;

      // 각 페이지 순회 및 워터마크 오버레이
      for (let pIdx = 0; pIdx < pageCount; pIdx++) {
        const page = pages[pIdx];
        const { width, height } = page.getSize();

        // 페이지 크기에 맞는 투명 워터마크 PNG 이미지 생성
        const overlayPngBytes = await createWatermarkOverlayPng(width, height, watermarkConfig);
        const embeddedImage = await pdfDoc.embedPng(overlayPngBytes);

        // 페이지 최상단에 오버레이 드로잉
        page.drawImage(embeddedImage, {
          x: 0,
          y: 0,
          width: width,
          height: height
        });

        // 페이지별 진행률 갱신
        const currentFileProgress = ((pIdx + 1) / pageCount) * (1 / totalFiles);
        const overallProgress = Math.round(((fileIdx / totalFiles) + currentFileProgress) * 100);
        els.progressBar.style.width = `${overallProgress}%`;
        els.progressPercent.textContent = `${overallProgress}%`;
      }

      const modifiedPdfBytes = await pdfDoc.save();
      const blob = new Blob([modifiedPdfBytes], { type: 'application/pdf' });
      const objectUrl = URL.createObjectURL(blob);

      state.processedDocs.push({
        name: file.name.replace(/\.pdf$/i, '') + '_watermarked.pdf',
        pdfBytes: modifiedPdfBytes,
        pageCount: pageCount,
        objectUrl: objectUrl
      });

    } catch (err) {
      console.error(`파일 처리 실패 (${file.name}):`, err);
      alert(`"${file.name}" 파일 처리 중 오류가 발생했습니다: ${err.message}`);
    }
  }

  // 처리 완료 화면 반영
  els.progressBar.style.width = '100%';
  els.progressPercent.textContent = '100%';
  els.progressText.textContent = '모든 문서의 워터마크 처리가 완료되었습니다!';
  els.btnProcess.disabled = false;

  displayResults();
}

els.btnProcess.addEventListener('click', processAllPdfs);

// 7. 결과 화면 렌더링 및 미리보기 로딩
function displayResults() {
  if (state.processedDocs.length === 0) return;

  // 일괄 다운로드 버튼 활성화
  els.btnDownloadAll.style.display = 'inline-flex';
  els.previewToolbar.style.display = 'flex';
  els.completedSection.style.display = 'flex';
  els.emptyState.style.display = 'none';
  els.canvasContainer.style.display = 'flex';

  // 문서 선택 셀렉트 박스 구성
  els.previewDocSelect.innerHTML = '';
  state.processedDocs.forEach((doc, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `${idx + 1}. ${doc.name} (${doc.pageCount}p)`;
    els.previewDocSelect.appendChild(opt);
  });

  // 완료 테이블 목록 구성
  els.completedTableBody.innerHTML = '';
  state.processedDocs.forEach((doc, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${doc.name}</strong></td>
      <td>${doc.pageCount} 페이지</td>
      <td><span class="status-badge-done">✓ 각인 완료</span></td>
      <td>
        <button type="button" class="btn-table-download" data-idx="${idx}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          PDF 다운로드
        </button>
      </td>
    `;
    els.completedTableBody.appendChild(tr);
  });

  // 테이블 내 개별 다운로드 버튼 이벤트
  els.completedTableBody.querySelectorAll('.btn-table-download').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      downloadSinglePdf(idx);
    });
  });

  // 1번째 문서 1페이지 뷰어로 로드
  state.currentPreviewIdx = 0;
  state.currentPreviewPage = 1;
  loadDocumentToViewer(0);
}

// 8. PDF.js 기반 미리보기 뷰어 렌더링
async function loadDocumentToViewer(docIndex) {
  const doc = state.processedDocs[docIndex];
  if (!doc) return;

  els.viewerLoader.style.display = 'flex';
  state.currentPreviewIdx = docIndex;
  state.currentPreviewPage = 1;
  state.totalPreviewPages = doc.pageCount;
  els.totalPagesNum.textContent = doc.pageCount;
  els.currentPageNum.textContent = '1';

  try {
    // pdf.js 라이브러리로 ArrayBuffer 파싱
    const loadingTask = pdfjsLib.getDocument({ data: doc.pdfBytes });
    state.pdfJsDoc = await loadingTask.promise;
    await renderViewerPage(1);
  } catch (err) {
    console.error('PDF 미리보기 로드 실패:', err);
  } finally {
    els.viewerLoader.style.display = 'none';
  }
}

async function renderViewerPage(pageNum) {
  if (!state.pdfJsDoc) return;
  els.viewerLoader.style.display = 'flex';

  try {
    const page = await state.pdfJsDoc.getPage(pageNum);
    
    // 뷰포트 크기 및 스케일 조정 (화면 너비에 맞춰 적절한 선명도 유지)
    const containerWidth = els.previewViewport.clientWidth - 48;
    const unscaledViewport = page.getViewport({ scale: 1 });
    const targetScale = Math.min(containerWidth / unscaledViewport.width, 1.3);
    const viewport = page.getViewport({ scale: targetScale });

    const canvas = els.pdfCanvas;
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    const renderContext = {
      canvasContext: context,
      viewport: viewport
    };

    await page.render(renderContext).promise;
    els.currentPageNum.textContent = pageNum;
    state.currentPreviewPage = pageNum;
  } catch (err) {
    console.error('페이지 렌더링 실패:', err);
  } finally {
    els.viewerLoader.style.display = 'none';
  }
}

// 미리보기 문서 변경
els.previewDocSelect.addEventListener('change', (e) => {
  const idx = parseInt(e.target.value, 10);
  loadDocumentToViewer(idx);
});

// 미리보기 페이지 이동
els.prevPageBtn.addEventListener('click', () => {
  if (state.currentPreviewPage > 1) {
    renderViewerPage(state.currentPreviewPage - 1);
  }
});

els.nextPageBtn.addEventListener('click', () => {
  if (state.currentPreviewPage < state.totalPreviewPages) {
    renderViewerPage(state.currentPreviewPage + 1);
  }
});

// 9. 다운로드 기능 구현 (개별 PDF & JSZip 일괄 압축)
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadSinglePdf(docIndex) {
  const doc = state.processedDocs[docIndex];
  if (!doc) return;
  const blob = new Blob([doc.pdfBytes], { type: 'application/pdf' });
  triggerDownload(blob, doc.name);
}

// 미리보기 상단 개별 다운로드
els.btnDownloadCurrent.addEventListener('click', () => {
  downloadSinglePdf(state.currentPreviewIdx);
});

// 전체 일괄 다운로드 (ZIP)
els.btnDownloadAll.addEventListener('click', async () => {
  if (state.processedDocs.length === 0) return;

  const originalHtml = els.btnDownloadAll.innerHTML;
  els.btnDownloadAll.innerHTML = `
    <div class="spinner" style="width:16px;height:16px;border-width:2px;"></div>
    <span>ZIP 압축 생성 중...</span>
  `;
  els.btnDownloadAll.disabled = true;

  try {
    const zip = new JSZip();
    state.processedDocs.forEach(doc => {
      zip.file(doc.name, doc.pdfBytes);
    });

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const zipName = `watermarked_documents_${dateStr}.zip`;

    const zipContent = await zip.generateAsync({ type: 'blob' });
    triggerDownload(zipContent, zipName);
  } catch (err) {
    console.error('ZIP 생성 실패:', err);
    alert('ZIP 압축 다운로드 중 오류가 발생했습니다.');
  } finally {
    els.btnDownloadAll.innerHTML = originalHtml;
    els.btnDownloadAll.disabled = false;
  }
});
